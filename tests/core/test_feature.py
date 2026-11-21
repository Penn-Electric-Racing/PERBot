"""Feature / View wiring through Bolt's real (async) dispatcher: Bolt injects listener arguments by
parameter name, so a handler that registers fine can still fail on its first request."""
import asyncio
import json
import re

import pytest
from slack_bolt.async_app import AsyncApp
from slack_bolt.authorization import AuthorizeResult
from slack_bolt.request.async_request import AsyncBoltRequest

from core.bolt import listener
from core.feature import Feature, command, task
from core.ui import Interaction, View, button


async def _authorize(**kw):
    return AuthorizeResult(enterprise_id=None, team_id='T1', bot_token='xoxb-test', bot_user_id='UB', bot_id='B1')


def make_app():
    # A stub authorize instead of a token: no auth.test call to Slack.
    return AsyncApp(signing_secret='x', request_verification_enabled=False, process_before_response=True,
                    authorize=_authorize)


def slash(name, text=''):
    return AsyncBoltRequest(mode='socket_mode', body={
        'type': 'slash_commands', 'command': name, 'text': text, 'user_id': 'U1', 'channel_id': 'C1',
        'team_id': 'T1', 'response_url': 'https://hooks.slack.test/x'})


def click(action_id, value='{}'):
    return AsyncBoltRequest(mode='socket_mode', body={
        'type': 'block_actions', 'user': {'id': 'U1'}, 'team': {'id': 'T1'}, 'container': {},
        'response_url': 'https://hooks.slack.test/x', 'message': {'blocks': [{'type': 'section'}]},
        'actions': [{'action_id': action_id, 'block_id': 'b', 'value': value, 'type': 'button'}]})


class Echo(View):
    def __init__(self):
        self.seen = []

    @button(re.compile(r'^echo_(a|b)$'))
    async def echo(self, interaction: Interaction):
        self.seen.append((interaction.user_id, interaction.action_id, json.loads(interaction.value),
                          interaction.message_blocks))


class Demo(Feature):
    name = 'demo'

    def __init__(self):
        self.calls, self.ran = [], []
        self.views = [Echo()]

    @command('/demo')
    async def demo(self, ack, command):
        await ack()
        self.calls.append(command['text'])

    @task
    async def job(self):
        self.ran.append(True)


async def test_command_methods_get_bolt_arguments():
    app, f = make_app(), Demo()
    f.register(app)
    resp = await app.async_dispatch(slash('/demo', 'hello'))
    assert resp.status == 200 and f.calls == ['hello']


async def test_view_buttons_get_an_interaction():
    app, f = make_app(), Demo()
    f.register(app)
    assert (await app.async_dispatch(click('echo_b', '{"n": 2}'))).status == 200
    assert f.views[0].seen == [('U1', 'echo_b', {'n': 2}, [{'type': 'section'}])]


async def test_tasks_run_on_start():
    f = Demo()
    await asyncio.wait_for(asyncio.gather(*f.start()), 1)
    assert f.ran == [True]


def test_listener_rejects_arguments_bolt_cannot_give():
    class Bad:
        async def handle(self, ack, nonsense):
            pass

    with pytest.raises(TypeError, match='nonsense'):
        listener(Bad().handle)


def test_listener_rejects_sync_methods():
    class Sync:
        def handle(self, ack):
            pass

    with pytest.raises(TypeError, match='async def'):
        listener(Sync().handle)


async def test_listener_drops_cls_of_classmethods():
    class C:
        got = []

        @classmethod
        async def handle(cls, ack, command):
            await ack()
            cls.got.append(command['text'])

    app = make_app()
    app.command('/c')(listener(C.handle))
    await app.async_dispatch(slash('/c', 'x'))
    assert C.got == ['x']


async def test_anon_command_dispatches():
    from anon.feature import Anon

    app = make_app()
    Anon().register(app)
    req = slash('/anon', 'hi')
    req.body['channel_name'] = 'not-allowed'
    resp = await app.async_dispatch(req)
    assert resp.status == 200 and '/anon` can only be used in' in resp.body
