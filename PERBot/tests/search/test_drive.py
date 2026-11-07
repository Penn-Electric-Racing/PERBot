import base64
import json

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from perbot.sources.drive import FileRoute, build_folder_index, route_file
from perbot.sources.google_auth import ServiceAccountAuth, ServiceAccountKey, build_assertion, parse_service_account_key

_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_public = _private.public_key()
KEY = ServiceAccountKey(
    client_email='perbot-drive@perbot-automations.iam.gserviceaccount.com',
    private_key=_private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode(),
)


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def test_service_account_assertion_is_a_valid_rs256_jwt_with_the_right_claims():
    jwt = build_assertion(KEY, ['https://www.googleapis.com/auth/drive.readonly'], 1_700_000_000)
    h, c, sig = jwt.split('.')
    header = json.loads(_b64url_decode(h))
    claims = json.loads(_b64url_decode(c))
    assert header == {'alg': 'RS256', 'typ': 'JWT'}
    assert claims['iss'] == KEY.client_email
    assert claims['scope'] == 'https://www.googleapis.com/auth/drive.readonly'
    assert claims['aud'] == 'https://oauth2.googleapis.com/token'
    assert claims['exp'] - claims['iat'] == 3600
    _public.verify(_b64url_decode(sig), f'{h}.{c}'.encode(), padding.PKCS1v15(), hashes.SHA256())


def test_key_parses_from_raw_json_or_base64_and_token_is_cached_until_near_expiry():
    raw = json.dumps({'client_email': KEY.client_email, 'private_key': KEY.private_key})
    assert parse_service_account_key(raw).client_email == KEY.client_email
    assert parse_service_account_key(base64.b64encode(raw.encode()).decode()).client_email == KEY.client_email
    with pytest.raises(ValueError):
        parse_service_account_key('{"client_email":"x"}')

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={'access_token': f'tok{calls}', 'expires_in': 3600})

    auth = ServiceAccountAuth(KEY, ['s'], http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert auth.access_token() == 'tok1'
    assert auth.access_token() == 'tok1'
    assert calls == 1


def f(id_, name, mime_type, parent=None, **extra):
    return {
        'id': id_,
        'name': name,
        'mimeType': mime_type,
        'parents': [parent] if parent else None,
        'modifiedTime': '2026-09-01T00:00:00Z',
        'createdTime': '2026-09-01T00:00:00Z',
        **extra,
    }


FOLDER = 'application/vnd.google-apps.folder'


def test_folder_index_builds_breadcrumbs_from_the_drive_root_and_applies_exclusions():
    folders = [
        f('mech', 'Mechanical', FOLDER, 'DRIVE'),
        f('acc', 'Accumulator', FOLDER, 'mech'),
        f('photos', 'Photos', FOLDER, 'acc'),
    ]
    index = build_folder_index(folders, {'DRIVE': 'PER Shared Drive'}, ['photos'])
    doc = f('d1', 'Pack CDR', 'application/vnd.google-apps.document', 'acc')
    pic = f('p1', 'IMG_1.jpg', 'image/jpeg', 'photos')
    assert index.path_of(doc) == ['PER Shared Drive', 'Mechanical', 'Accumulator']
    assert index.excluded(doc) is False
    assert index.excluded(pic) is True
    assert index.path_of(f('x', 'orphan', 'text/plain', 'missing')) == []


def test_files_route_to_export_download_or_skip_by_type_and_size():
    mx = 20_000_000
    assert route_file(f('a', 'Doc', 'application/vnd.google-apps.document'), mx) == FileRoute('export', mime='text/markdown')
    assert route_file(f('b', 'Sheet', 'application/vnd.google-apps.spreadsheet'), mx) == FileRoute('export', mime='text/csv')
    assert route_file(f('c', 'x.pdf', 'application/pdf', size='1000'), mx) == FileRoute('download', parser='pdf')
    assert route_file(f('d', 'big.pdf', 'application/pdf', size=str(mx + 1)), mx).type == 'skip'
    assert route_file(f('e', 'part.SLDPRT', 'application/octet-stream'), mx).type == 'skip'
    assert route_file(f('g', 'Folder', FOLDER), mx).type == 'skip'


def test_folders_for_seasons_older_than_min_rev_are_excluded():
    folders = [
        f('r7', 'REV7', FOLDER, 'DRIVE'),
        f('r11', 'REV11', FOLDER, 'DRIVE'),
        f('r11sub', 'Accumulator', FOLDER, 'r11'),
        f('common', 'Common Resources', FOLDER, 'DRIVE'),
    ]
    index = build_folder_index(folders, {'DRIVE': 'PER'}, [], 10)
    assert index.excluded(f('a', 'old', 'application/pdf', 'r7')) is True
    assert index.excluded(f('b', 'new', 'application/pdf', 'r11sub')) is False
    assert index.excluded(f('c', 'shared', 'application/pdf', 'common')) is False
