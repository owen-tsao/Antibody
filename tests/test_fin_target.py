"""`FinTarget` (plan 10 A7): Intercom Fin behind the Fin Agent API, against a fake — no workspace exists to test on."""

from __future__ import annotations

import json
import time
import urllib.error

import pytest
from conftest import FakeFin

from chaos import target as target_mod
from chaos.schemas import AgentConfig, Scenario
from chaos.target import FinTarget, html_to_text, resolve_target
from chaos.toolbus import ToolSession

REPLIED = {"event_name": "fin_replied", "conversation_id": "c", "message": {"id": "m1", "author": "fin", "body": "<p>Your flight <em>SA101</em> is on time.</p>"}, "status": "replying"}
REPLIED_2 = {"event_name": "fin_replied", "conversation_id": "c", "message": {"id": "m2", "author": "fin", "body": "<p>Gate B4.<br>Boarding at 9:10. [1]</p>"}, "status": "replying"}
DONE = {"event_name": "fin_status_updated", "conversation_id": "c", "status": "awaiting_user_reply"}
CHUNK = {"event_name": "fin_reply_chunk", "conversation_id": "c", "chunk_text": "Your fl", "status": "replying"}
RESOLVED = {"event_name": "fin_status_updated", "conversation_id": "c", "status": "resolved"}
COMPLETE = {"event_name": "fin_status_updated", "conversation_id": "c", "status": "complete"}
ESCALATED = {"event_name": "fin_status_updated", "conversation_id": "c", "status": "escalated", "reason": "Escalation requested by user"}


def _session() -> ToolSession:
    sc = Scenario(id="s", kind="ambiguous_request", title="t", user_message="Is SA101 on time?", customer_id="cust_maya", expected_behavior="answer")
    s = ToolSession(cfg=AgentConfig(version=2, system_prompt="x"), scenario=sc, customer_turns=[sc.user_message])
    s.session_id = "conv-7"
    return s


def _run(fin: FakeFin, **kw):
    t = FinTarget("acme", base_url=fin.url, token="tok", **kw)
    return t, t.run_episode(_session(), "Is SA101 on time?")


def test_selected_by_name_and_only_the_gateway_patch_reaches_it(monkeypatch):
    t = resolve_target("fin:acme")
    assert isinstance(t, FinTarget) and t.name == "fin:acme" and t.transport == "fin"
    assert t.supported_patch_kinds == {"tighten_tool_policy"}
    assert target_mod.banned_patch_kinds(t) == ["add_guardrail_rule", "add_tool_validator", "rewrite_system_prompt"]
    monkeypatch.setenv(target_mod.TARGET_ENV, "fin:acme")
    assert target_mod.target_name() == "fin:acme"
    with pytest.raises(ValueError, match="fin:<label>"):
        resolve_target("fin:")
    monkeypatch.setenv(target_mod.FIN_URL_ENV, "http://127.0.0.1:1/")
    assert FinTarget("x").base_url == "http://127.0.0.1:1"
    monkeypatch.delenv(target_mod.FIN_URL_ENV)
    assert FinTarget("x").base_url == "https://api.intercom.io"


def test_happy_path_reads_the_reply_parts_off_the_stream():
    fin = FakeFin([CHUNK, REPLIED, REPLIED_2, DONE, RESOLVED])
    try:
        _, ep = _run(fin)
    finally:
        fin.close()
    assert ep.error is None
    assert ep.final_reply == "Your flight SA101 is on time.\n\nGate B4.\nBoarding at 9:10. [1]"
    assert ep.tool_calls == [] and ep.domain is None and ep.end_state is None, "Fin's tools are invisible; nothing for the judge to compare"
    assert ep.config_version == 2 and ep.scenario_id == "s"
    start = fin.started[0]
    assert start["path"] == "/fin/start" and start["conversation_id"] == "conv-7"
    assert start["message"]["author"] == "user" and start["message"]["body"] == "Is SA101 on time?" and start["message"]["timestamp"].endswith("Z")
    assert start["user"] == {"id": "cust_maya", "email": _session().customer_email}
    assert fin.headers[0] == {"Authorization": "Bearer tok", "Intercom-Version": "2.16"}
    assert fin.stream_hits == 1


def test_legacy_reply_status_and_complete_both_end_the_episode():
    legacy = {**REPLIED, "status": "awaiting_user_reply"}
    fin = FakeFin([legacy, {"event_name": "fin_replied", "message": {"body": "<p>never read</p>"}, "status": "replying"}])
    try:
        assert _run(fin)[1].final_reply == "Your flight SA101 is on time."
    finally:
        fin.close()
    fin = FakeFin([RESOLVED, COMPLETE], hang=True)
    try:
        ep = _run(fin, cap_s=2.0)[1]
        assert ep.error is None and ep.final_reply == "", "complete with no reply is a finished conversation, not a timeout"
    finally:
        fin.close()


def test_escalation_ends_the_episode_as_a_handoff_not_an_error():
    fin = FakeFin([REPLIED, ESCALATED])
    try:
        _, ep = _run(fin)
    finally:
        fin.close()
    assert ep.error is None
    assert ep.final_reply == "Your flight SA101 is on time.\n\n(Fin escalated this conversation to a human agent: Escalation requested by user)"


def test_timeout_keeps_what_was_read_and_says_so():
    fin = FakeFin([REPLIED], hang=True)
    try:
        _, ep = _run(fin, cap_s=0.6)
    finally:
        fin.close()
    assert ep.final_reply == "Your flight SA101 is on time."
    assert ep.error == "Fin did not finish within 0.6s (last status: none)"
    slow = FakeFin([REPLIED, DONE], gap=0.5)
    try:
        assert _run(slow, cap_s=0.3)[1].error.startswith("Fin did not finish within 0.3s")
    finally:
        slow.close()


def test_missing_token_missing_sse_and_dead_api_are_episode_errors(monkeypatch):
    monkeypatch.delenv(target_mod.FIN_TOKEN_ENV, raising=False)
    ep = FinTarget("acme", base_url="http://127.0.0.1:1").run_episode(_session(), "hi")
    assert ep.error.startswith("INTERCOM_FIN_TOKEN not set")
    fin = FakeFin([REPLIED, DONE], sse=False)
    try:
        assert "no sse_subscription_url" in _run(fin)[1].error
    finally:
        fin.close()
    dead = FakeFin([])
    dead.close()
    ep = FinTarget("acme", base_url=dead.url, token="tok").run_episode(_session(), "hi")
    assert ep.error.startswith("fin/start failed:")
    monkeypatch.setenv(target_mod.FIN_TOKEN_ENV, "from-env")
    fin = FakeFin([DONE])
    try:
        FinTarget("acme", base_url=fin.url).run_episode(_session(), "hi")
        assert fin.headers[0]["Authorization"] == "Bearer from-env"
    finally:
        fin.close()


def test_html_to_text():
    assert html_to_text("<p>Hello &amp; welcome</p><p>Line two<br/>three</p>") == "Hello & welcome\nLine two\nthree"
    assert html_to_text("  plain   text ") == "plain text"
    assert html_to_text("<ul><li>a</li><li>b</li></ul>") == "a\nb"
    assert html_to_text("") == ""


# --- S5: the SSE URL is data from the remote, and the stream is unbounded input ----------------------------------


def test_the_sse_url_must_be_the_fin_apis_own_scheme_and_host(tmp_path):
    """`sse_subscription_url` comes back in a response: only the API's own scheme and host (or a host under the same
    domain) may be followed. `file://`, `data:`, `ftp://` and third-party hosts end the episode with a named error
    and are never opened — the opener itself no longer carries handlers for those schemes either."""
    secret = tmp_path / "hosts"
    secret.write_text("root:x:0:0\n")
    for bad in (f"file://{secret}", "data:text/plain,{\"event_name\":\"fin_replied\"}", "ftp://127.0.0.1/x", "https://evil.example/stream", "http://127.0.0.2:9/stream"):
        fin = FakeFin([REPLIED, DONE], sse_url=bad)
        try:
            _, ep = _run(fin)
        finally:
            fin.close()
        assert ep.final_reply == "" and "root:x" not in ep.final_reply
        assert ep.error is not None and ep.error.startswith("fin/start returned an sse_subscription_url Antibody will not follow"), (bad, ep.error)
        assert fin.stream_hits == 0
    assert target_mod._same_origin("https://sse.intercom.io/x", "https://api.intercom.io") is True, "a sibling host under the API's domain"
    assert target_mod._same_origin("http://api.intercom.io/x", "https://api.intercom.io") is False, "no downgrade"
    assert target_mod._same_origin("https://intercom.io.evil.example/x", "https://api.intercom.io") is False
    assert target_mod._same_origin("http://10.0.0.1/x", "http://127.0.0.1:8000") is False, "an IP is exact"
    with pytest.raises(urllib.error.URLError):
        target_mod._opener.open(f"file://{secret}")
    with pytest.raises(urllib.error.URLError):
        target_mod._opener.open("data:text/plain,hi")


def test_the_stream_is_capped_in_bytes_per_line_and_in_idle_time(monkeypatch):
    """A huge `data:` line, a multi-megabyte stream and a byte-a-time drip that never sends a newline are each ended
    with what was read so far and an error that names the cap, well inside the episode cap."""
    monkeypatch.setattr(target_mod, "FIN_LINE_CAP_BYTES", 4096)
    monkeypatch.setattr(target_mod, "FIN_STREAM_CAP_BYTES", 16 * 1024)
    first = f"event: message\ndata: {json.dumps(REPLIED)}\n\n".encode()
    huge_line = first + b"data: " + b"x" * 8192 + b"\n\n"
    fin = FakeFin([], raw=huge_line)
    try:
        t0 = time.monotonic()
        _, ep = _run(fin, cap_s=5.0)
    finally:
        fin.close()
    assert time.monotonic() - t0 < 3.0
    assert ep.final_reply == "Your flight SA101 is on time." and ep.error == "Fin stream ended early: a line exceeded 4 KiB (last status: none)"
    many = first + b"".join(f"data: {json.dumps(CHUNK)}\n\n".encode() for _ in range(400))
    fin = FakeFin([], raw=many)
    try:
        _, ep = _run(fin, cap_s=5.0)
    finally:
        fin.close()
    assert ep.error == "Fin stream ended early: exceeded 16 KiB (last status: none)"
    # A byte every 0.5 s with no newline: bounded by the idle cap (nothing arrives for that long), not by the episode cap.
    monkeypatch.setattr(target_mod, "FIN_IDLE_CAP_S", 0.3)
    fin = FakeFin([], raw=first, trickle=b"data: " + b"y" * 1000, drip=0.5)
    try:
        t0 = time.monotonic()
        _, ep = _run(fin, cap_s=10.0)
    finally:
        fin.close()
    assert time.monotonic() - t0 < 3.0
    assert ep.final_reply == "Your flight SA101 is on time." and ep.error == "Fin stream ended early: no bytes for 0.3s (last status: none)"
    # A normal stream is unaffected by the caps, and the JSON reader has a cap of its own.
    fin = FakeFin([REPLIED, DONE])
    try:
        assert _run(fin, cap_s=5.0)[1].error is None
    finally:
        fin.close()
    monkeypatch.setattr(target_mod, "MAX_JSON_BYTES", 64)
    fin = FakeFin([DONE])
    try:
        err = _run(fin)[1].error
    finally:
        fin.close()
    assert err == "fin/start failed: response larger than 64 bytes"
