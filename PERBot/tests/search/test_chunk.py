import re

from perbot.utils.chunk import ChunkOptions, build_embed_text, chunk_markdown

opts = ChunkOptions(target=300, max=450, min=80)


def test_splits_on_headings_and_remembers_the_heading_path():
    md = '\n'.join([
        '# Introduction',
        'The PCM is the brain of the car. ' * 6,
        '## What is the PCM?',
        'It translates pedal inputs into torque requests. ' * 6,
        '## Torque security',
        'It must check readings are consistent. ' * 6,
    ])
    chunks = chunk_markdown(md, opts)
    assert len(chunks) >= 3, f'got {len(chunks)}'
    assert chunks[0].heading == 'Introduction'
    assert chunks[1].heading == 'Introduction › What is the PCM?'
    assert chunks[2].heading == 'Introduction › Torque security'
    for c in chunks:
        assert len(c.text) <= opts.max + 1, f'chunk too long: {len(c.text)}'


def test_small_sections_merge_instead_of_becoming_crumbs():
    chunks = chunk_markdown('# A\nshort\n# B\nalso short\n# C\ntiny', opts)
    assert len(chunks) == 1
    assert '# C' in chunks[0].text


def test_long_lines_are_split_at_sentence_boundaries_never_mid_word():
    chunks = chunk_markdown('Sentence one is here. ' * 60, opts)
    assert len(chunks) > 1
    for c in chunks:
        assert len(c.text) <= opts.max
        assert re.search(r'\.$', c.text.strip()), c.text[-20:]


def test_code_fences_are_not_split_on_hash_lines():
    chunks = chunk_markdown('```sh\n# comment inside code\necho hi\n```\n# Real heading\ntext', opts)
    assert chunks[0].heading is None
    assert '# Real heading' in chunks[-1].text


def test_embed_text_carries_title_breadcrumb_and_heading():
    s = build_embed_text('REV11 PCM Documentation', ['Electrical', 'PCM'], 'Intro › What', 'body')
    assert s == 'REV11 PCM Documentation\nElectrical › PCM\nIntro › What\n\nbody'
    assert build_embed_text('T', [], None, 'b') == 'T\n\nb'
