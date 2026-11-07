from perbot.utils.notion_text import clean_notion_markdown, extract_doc_date, extract_rev_number, is_template_placeholder

S3 = (
    'https://prod-files-secure.s3.us-west-2.amazonaws.com/69f38b25/abc/Screenshot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    '&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host&x-id=GetObject'
)


def test_drops_signed_image_urls_but_keeps_captions():
    out = clean_notion_markdown(f'Intro\n![High level overview of the PCM]({S3})\n![]({S3})\nAfter')
    assert 'X-Amz' not in out, out
    assert '[Image: High level overview of the PCM]' in out
    assert 'After' in out


def test_unwraps_columns_callouts_toggles_and_drops_empty_blocks_and_attribute_suffixes():
    md = '\n'.join([
        '<table_of_contents color="gray"/>',
        '# Assembly procedure {toggle="true"}',
        '<columns>',
        '\t<column ratio="50">',
        '\t\tThe PCM Box is a tightly integrated package.',
        '\t\t<empty-block/>',
        '\t</column>',
        '</columns>',
        '<callout icon="⚠️" color="yellow_bg">',
        '\tGenerated files are **not saved to Git**.',
        '</callout>',
        '<details>',
        '<summary>Pages</summary>',
        '\t<page url="https://app.notion.com/p/abc">Board Architecture</page>',
        '</details>',
    ])
    out = clean_notion_markdown(md)
    assert '<' not in out, out
    assert '# Assembly procedure' in out
    assert 'toggle=' not in out
    assert 'The PCM Box is a tightly integrated package.' in out
    assert '**not saved to Git**' in out
    assert '**Pages**' in out
    assert 'Board Architecture' in out


def test_tables_become_pipe_rows_and_mentions_become_text():
    md = (
        '<table header-row="true"><colgroup><col width="1"/></colgroup>'
        '<tr><td>Page</td><td>What is in it</td></tr>'
        '<tr><td><mention-page url="https://app.notion.com/p/x">FreeRTOS</mention-page></td><td>Tasks and the 1 ms tick</td></tr></table>\n'
        'Due <mention-date start="2019-02-09"/> by <mention-user url="user://abc"/>. See <database url="x">Ops Tasks</database>.'
    )
    out = clean_notion_markdown(md)
    assert 'Page | What is in it' in out
    assert 'FreeRTOS | Tasks and the 1 ms tick' in out
    assert 'Due 2019-02-09 by .' in out
    assert 'Database: Ops Tasks' in out


def test_leaves_code_fences_alone():
    md = 'Before\n```cpp\n#include <stdint.h>\nstd::vector<Box<T>> x; // {color="gray"}\n```\n<span underline="true">after</span>'
    out = clean_notion_markdown(md)
    assert '#include <stdint.h>' in out
    assert 'std::vector<Box<T>> x; // {color="gray"}' in out
    assert out.endswith('after')


def test_unescapes_notion_escaped_punctuation():
    assert clean_notion_markdown('Shirt sale \\$10 \\[TODO\\]') == 'Shirt sale $10 [TODO]'


def test_template_placeholders_are_detected():
    t = (
        '## Summary\nProvide a brief summary of the issue.\n## Details\n'
        'Describe the issue in detail, including any relevant background information.'
    )
    assert is_template_placeholder(t) is True
    assert is_template_placeholder(f"{t}\n{'real content ' * 80}") is False


def test_rev_numbers_and_dates_from_titles():
    assert extract_rev_number('REV11 PCM Documentation') == 11
    assert extract_rev_number('Rev 9 LUDWIG') == 9
    assert extract_rev_number("Lauren's Rev8 Reflection") == 8
    assert extract_rev_number('Cooling', 'Mechanical › REV12 › Cooling') == 12
    assert extract_rev_number('nothing here') is None
    assert extract_doc_date('2018-09-04 Weekly Update') == '2018-09-04'
    assert extract_doc_date('REVX Updates - 02/12/2025') == '2025-02-12'
    assert extract_doc_date('9SLASH25SLASH19 Mech Updates') == '2019-09-25'
    assert extract_doc_date('4/15/26 Mech Meeting Notes') == '2026-04-15'
    assert extract_doc_date('July 13, 2022 REV8 Weekly Update') == '2022-07-13'
    assert extract_doc_date('11/5 Mechanical Meeting') is None
