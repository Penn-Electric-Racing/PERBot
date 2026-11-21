"""Every feature's listeners, dispatched through Bolt: each command, button and modal reaches its
method with the arguments Bolt injects. The work behind them is stubbed; what's tested is the
wiring (a handler that registers fine can still fail on its first request)."""
import json

import pytest
from slack_bolt import BoltRequest
from slack_bolt.context.respond.respond import Respond
from slack_sdk import WebClient

from tests.core.test_feature import click, make_app, slash


@pytest.fixture
def slack(monkeypatch):
    """Record respond() and Web API calls instead of sending them."""
    sent = {'respond': [], 'api': []}
    monkeypatch.setattr(Respond, '__call__', lambda self, *a, **kw: sent['respond'].append(kw or {'text': a[0]}))
    monkeypatch.setattr(WebClient, 'api_call', lambda self, method, **kw: sent['api'].append(method) or {'ok': True})
    return sent


def submit(callback_id, values=None, metadata=''):
    return BoltRequest(mode='socket_mode', body={
        'type': 'view_submission', 'user': {'id': 'U1'}, 'team': {'id': 'T1'},
        'view': {'id': 'V1', 'type': 'modal', 'callback_id': callback_id, 'private_metadata': metadata,
                 'state': {'values': values or {}}}})


def registered(feature):
    app = make_app()
    feature.register(app)
    return app


def test_every_feature_registers_on_one_app():
    from anon.feature import Anon
    from arrivals.feature import Arrivals
    from benbuys.feature import BenBuys
    from benbuys.slack import BenbuysDeps
    from ops_tasks.feature import OpsTasks
    from price_check.feature import PriceCheck
    from race.feature import Race
    from search.feature import Search
    from sponsorship.feature import Sponsorship

    app = make_app()
    features = [Search(), Anon(), PriceCheck(), Race(), OpsTasks(), BenBuys(BenbuysDeps(notion=None, mailer=None)),
                Arrivals(), Sponsorship()]
    for f in features:
        f.register(app)
    assert len({f.name for f in features}) == len(features)


def test_benbuys_help(slack):
    from benbuys.feature import BenBuys
    from benbuys.slack import USAGE, BenbuysDeps

    app = registered(BenBuys(BenbuysDeps(notion=None, mailer=None)))
    assert app.dispatch(slash('/benbuys', 'help')).status == 200
    assert slack['respond'] == [{'response_type': 'ephemeral', 'text': USAGE}]


def test_race_help(slack):
    from race.feature import Race
    from race.slack import USAGE

    app = registered(Race(load=lambda _p: []))
    assert app.dispatch(slash('/race', 'help')).status == 200
    assert slack['respond'][0]['text'] == USAGE


def test_sponsor_command_reaches_the_dispatcher(monkeypatch):
    import sponsorship.feature
    from sponsorship.feature import Sponsorship

    seen = []
    monkeypatch.setattr(sponsorship.feature, 'handle_command', lambda ack, command, respond, client: (ack(), seen.append(command['text'])))
    app = registered(Sponsorship())
    assert app.dispatch(slash('/sponsor', 'quota')).status == 200
    assert seen == ['quota']


def test_deal_buttons_reach_their_callbacks(monkeypatch):
    import sponsorship.views
    from sponsorship.feature import Sponsorship

    seen = []
    monkeypatch.setattr(sponsorship.views, '_clicked', lambda body, action, respond, msg: seen.append(action['action_id']))
    app = registered(Sponsorship())
    for action_id in ('deal_stage_contacted', 'deal_followed_up'):
        assert app.dispatch(click(action_id)).status == 200
    assert seen == ['deal_stage_contacted', 'deal_followed_up']


def test_ops_task_button_refuses_someone_elses_list(slack):
    from ops_tasks.feature import OpsTasks

    app = registered(OpsTasks())
    value = json.dumps({'u': 'U2', 't': 'task1'})
    assert app.dispatch(click('ops_task_done', value)).status == 200
    assert "isn't yours" in slack['respond'][0]['text']


def test_assign_without_a_task_opens_the_form(slack):
    from ops_tasks.feature import OpsTasks

    app = registered(OpsTasks())
    req = slash('/assign', '')
    req.body['trigger_id'] = 'tr1'
    assert app.dispatch(req).status == 200
    assert slack['api'] == ['views.open']


def test_assign_modal_submission_is_routed(monkeypatch):
    import ops_tasks.feature
    from ops_tasks.assign import ASSIGN_MODAL_ID
    from ops_tasks.feature import OpsTasks

    seen = []
    monkeypatch.setattr(ops_tasks.feature.OpsTasks, 'assign_submit',
                        lambda self, ack, body, view, client: (ack(), seen.append(view['callback_id'])))
    app = registered(OpsTasks())
    assert app.dispatch(submit(ASSIGN_MODAL_ID)).status == 200
    assert seen == [ASSIGN_MODAL_ID]


def test_package_card_buttons(monkeypatch):
    import arrivals.views
    from arrivals.views import PackageCardView

    seen = []
    monkeypatch.setattr(arrivals.views, 'handle_click', lambda body, action, respond, client: seen.append(action['action_id']))
    app = make_app()
    PackageCardView().register(app)
    app.dispatch(click('arrival_items'))  # a checkbox toggle: nothing to do yet
    app.dispatch(click('arrival_mark:0'))
    assert seen == ['arrival_mark:0']


def test_arrivals_is_off_without_a_channel(monkeypatch):
    from arrivals.feature import Arrivals

    monkeypatch.setattr(Arrivals, 'enabled', property(lambda self: False))
    app = registered(Arrivals())
    assert app._listeners == []


def test_indexstatus(slack):
    from search.feature import Search

    class Docs:
        index = type('Index', (), {'post': None})()

        def index_status(self, ack, command, client):
            ack()
            client.chat_postEphemeral(channel=command['channel_id'], user=command['user_id'], text='ok')

    app = registered(Search(Docs()))
    assert app.dispatch(slash('/indexstatus')).status == 200
    assert slack['api'] == ['chat.postEphemeral']
