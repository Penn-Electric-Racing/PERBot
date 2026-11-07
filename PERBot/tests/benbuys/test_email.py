import base64
import json
import re

import httpx
import pytest

from perbot.benbuys.email import build_requisition_email, render_email
from perbot.benbuys.mailer import GmailApiMailer, WebhookMailer, to_rfc822

from .helpers import test_adapter

BASE = dict(from_addr='electric@engineering.upenn.edu', cc=['oat@engineering.upenn.edu', 'arjunsh@sas.upenn.edu'], approval_threshold=500)


def email(req='4321745', total=10, lines=1):
    return build_requisition_email(test_adapter, requisition_number=req, total=total, line_count=lines, **BASE)


def test_email_at_most_500_no_approval_subject_no_approval_question():
    e = email(total=402.02, lines=17)
    assert e.subject == '[NO APPROVAL REQUIRED] PER Requisition 4321745'
    assert e.approval_required is False
    assert e.to == ['purchasing@engineering.upenn.edu']
    assert e.body == (
        'Hi,\n\nI just placed Requisition 4321745 on BenBuys for a DigiKey order for electrical, and the order total is '
        '$402.02 (17 line items). Thank you for placing the order!\n\nBest,\nKatherine Shen'
    )


def test_email_over_500_approval_required_subject_and_question_before_the_thank_you():
    e = email('4321746', 1234.5, 1)
    assert e.subject == '[APPROVAL REQUIRED] PER Requisition 4321746'
    assert e.approval_required is True
    assert re.search(
        r'order total is \$1,234\.50 \(1 line item\)\. Dr\. Tertuliano, do you approve\? Thank you for placing the order!', e.body
    )


def test_exactly_500_is_not_approval_required():
    assert email('123456', 500, 2).approval_required is False


def test_render_email_and_to_rfc822_carry_from_to_cc_subject():
    e = email()
    assert re.match(
        r'^From: electric@engineering\.upenn\.edu\nTo: purchasing@engineering\.upenn\.edu\nCc: oat@engineering\.upenn\.edu, '
        r'arjunsh@sas\.upenn\.edu\nSubject: \[NO APPROVAL REQUIRED\] PER Requisition 4321745\n\nHi,',
        render_email(e),
    )
    raw = to_rfc822(e)
    assert re.match(
        r'^From: electric@engineering\.upenn\.edu\r\nTo: purchasing@engineering\.upenn\.edu\r\nCc: oat@engineering\.upenn\.edu, '
        r'arjunsh@sas\.upenn\.edu\r\nSubject: \[NO APPROVAL REQUIRED\] PER Requisition 4321745\r\nMIME-Version: 1\.0\r\n',
        raw,
    )
    assert re.search(r'\r\n\r\nHi,\r\n\r\nI just placed', raw)


def test_gmail_mailer_refreshes_the_token_then_posts_a_base64url_raw_message():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if 'oauth2' in str(request.url):
            return httpx.Response(200, json={'access_token': 'tok'})
        return httpx.Response(200, json={'id': 'msg-1'})

    mailer = GmailApiMailer('id', 'sec', 'rt', http=httpx.Client(transport=httpx.MockTransport(handler)))
    e = email()
    assert mailer.send(e) == 'msg-1'
    assert len(calls) == 2
    assert calls[0].content.decode() == 'client_id=id&client_secret=sec&refresh_token=rt&grant_type=refresh_token'
    assert calls[1].headers['Authorization'] == 'Bearer tok'
    raw = json.loads(calls[1].content)['raw']
    assert not re.search(r'[+/=]', raw)
    assert base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)).decode('utf-8') == to_rfc822(e)


def test_gmail_mailer_a_failed_token_refresh_throws_before_any_send():
    sends = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal sends
        if 'oauth2' in str(request.url):
            return httpx.Response(400, json={'error': 'invalid_grant', 'error_description': 'Token has been expired or revoked.'})
        sends += 1
        return httpx.Response(200, json={})

    mailer = GmailApiMailer('id', 'sec', 'rt', http=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(RuntimeError, match='invalid_grant.*expired or revoked'):
        mailer.send(email())
    assert sends == 0


def test_webhook_mailer_posts_the_flat_json_shape_and_surfaces_non_2xx():
    seen = []

    def ok(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(202)

    e = email()
    WebhookMailer('https://example.test/flow', http=httpx.Client(transport=httpx.MockTransport(ok))).send(e)
    assert list(seen[0].keys()) == ['from', 'to', 'cc', 'subject', 'body']
    assert seen[0]['cc'] == 'oat@engineering.upenn.edu;arjunsh@sas.upenn.edu'
    bad = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500, text='nope')))
    with pytest.raises(RuntimeError, match='Email webhook failed: 500 nope'):
        WebhookMailer('https://example.test/flow', http=bad).send(e)
