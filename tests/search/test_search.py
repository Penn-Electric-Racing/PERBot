import numpy as np

from services.index_store import assemble_index
from services.search import parse_query, rank_pages


def page(id_, title, path, **extra):
    return {
        'id': id_,
        'source': 'notion',
        'kind': 'doc',
        'title': title,
        'url': f'https://notion.so/{id_}',
        'path': [*path, title],
        'pathText': ' › '.join([*path, title]),
        'createdTime': '2025-01-01T00:00:00.000Z',
        'lastEditedTime': '2025-01-01T00:00:00.000Z',
        'revNumber': None,
        'docDate': None,
        'isHistorical': False,
        'textLength': 100,
        'inferredBranch': 'unknown',
        'inferredSubsystem': 'unknown',
        'inferredDocType': 'unknown',
        **extra,
    }


def fixture():
    """Three tiny 4-d "embeddings" so vector and lexical signals can be controlled independently."""
    return {
        'version': 3,
        'generatedAt': '2026-01-01T00:00:00.000Z',
        'currentRev': 'REV12',
        'embeddingModel': 'test',
        'embeddingDims': 4,
        'pages': [
            page('pcm11', 'REV11 PCM Documentation', ['Electrical', 'PCM'], revNumber=11),
            page('pcm8', 'PCM REV8', ['Electrical', 'Archive'], revNumber=8, isHistorical=True),
            page('meet', '11/5 Mechanical Meeting', ['Mechanical'], inferredDocType='meeting_notes'),
        ],
        'chunks': [
            {'id': 'pcm11:0', 'pageId': 'pcm11', 'chunkIndex': 0, 'heading': None,
             'text': 'The PCM translates pedal inputs into torque requests.', 'hash': 'a', 'scale': 1 / 127},
            {'id': 'pcm8:0', 'pageId': 'pcm8', 'chunkIndex': 0, 'heading': None,
             'text': 'The PCM senses brake angle and requests negative torque.', 'hash': 'b', 'scale': 1 / 127},
            {'id': 'meet:0', 'pageId': 'meet', 'chunkIndex': 0, 'heading': None,
             'text': 'PCM box wiring was discussed; epoxy ordered.', 'hash': 'c', 'scale': 1 / 127},
        ],
    }


EMB = np.array([127, 0, 0, 0, 114, 13, 0, 0, 102, 25, 0, 0], dtype=np.int8)


def test_parse_query_pulls_out_filters():
    p = parse_query('rev:11 subsystem:PCM historical:false torque requests')
    assert p['filters'] == {'season': 'REV11', 'subsystem': 'pcm', 'historical': False}
    assert p['cleaned'] == 'torque requests'
    assert parse_query('season:12 x')['filters']['season'] == 'REV12'


def test_current_doc_outranks_historical_and_meeting_notes_for_the_same_topic():
    loaded = assemble_index(fixture(), EMB)
    q = np.array([1, 0, 0, 0], dtype=np.float32)
    ranked = rank_pages(loaded, parse_query('tell me about PCM'), q)
    assert ranked[0].page['id'] == 'pcm11'
    assert next(r for r in ranked if r.page['id'] == 'pcm8').score < ranked[0].score


def test_filters_restrict_candidates():
    loaded = assemble_index(fixture(), EMB)
    q = np.array([1, 0, 0, 0], dtype=np.float32)
    assert [r.page['id'] for r in rank_pages(loaded, parse_query('historical:true PCM'), q)] == ['pcm8']
    assert [r.page['id'] for r in rank_pages(loaded, parse_query('rev:11 PCM'), q)] == ['pcm11']


def test_a_title_hit_beats_a_body_only_hit():
    loaded = assemble_index(fixture(), EMB)
    # Same vector similarity for everyone; only the lexical/title signals differ.
    q = np.array([0.7, 0.7, 0, 0], dtype=np.float32)
    assert rank_pages(loaded, parse_query('mechanical meeting'), q)[0].page['id'] == 'meet'
