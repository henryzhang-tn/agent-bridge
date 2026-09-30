#!/usr/bin/env python3
"""Run the installed Hermes engine; reuse inference credentials only in memory."""
import contextlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
import urllib.error
from urllib.parse import urlparse

import yaml
from dotenv import dotenv_values


def settings():
    source = Path(os.environ.get("HERMES_WORKER_HOME", str(Path.home() / ".hermes")))
    config = yaml.safe_load((source / "config.yaml").read_text()) or {}
    provider = (config.get("model") or {}).get("provider")
    if provider != "zai":
        raise ValueError("This Hermes adapter currently supports the configured zai provider; provider changes require explicit configuration.")
    values = dotenv_values(source / ".env")
    secret = values.get("GLM_API_KEY") or values.get("ZAI_API_KEY") or values.get("Z_AI_API_KEY")
    base = values.get("GLM_BASE_URL") or (config.get("model") or {}).get("base_url")
    if not secret or not base:
        raise ValueError("Hermes needs an existing GLM credential and explicit inference base URL.")
    parsed = urlparse(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Unsupported credential-bearing inference URL")
    if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Remote inference requires HTTPS")
    return {"provider": provider, "secret": secret, "base": base.rstrip("/"),
            "model": (config.get("model") or {}).get("default"), "source": source}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def catalog(config):
    models = [config["model"]] if config["model"] else []
    source = "local-config"
    status = None
    try:
        request = urllib.request.Request(config["base"] + "/models", headers={"Authorization": "Bearer " + config["secret"]})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            status = response.status
            body = json.load(response)
            remote = [x["id"] for x in body.get("data", []) if isinstance(x.get("id"), str)]
            if remote:
                models, source = remote, "provider-catalog"
    except urllib.error.HTTPError as error:
        status = error.code
    except Exception:
        status = "unavailable"
    return {"worker": "hermes", "runtime": "Hermes AIAgent", "catalogSource": source, "catalogStatus": status,
            "models": [{"provider_id": config["provider"], "model": model,
                        "reasoning_levels": ["low", "high", "max"] if re.search(r"glm-5\.3", model, re.I) else ["provider-default"]}
                       for model in models],
            "note": "Catalog query sends no inference prompt. Local-config entries do not prove entitlement. Only the existing configured GLM provider is used."}


def run_job(job, config, available):
    state = json.loads((job / "state.json").read_text())
    selected = next((x for x in available["models"] if x["provider_id"] == state["provider"] and x["model"] == state["model"]), None)
    if not selected or state["effort"] not in selected["reasoning_levels"]:
        raise ValueError("Hermes model/provider/effort is unavailable; refresh list_models.")
    runtime = Path(os.environ.get("HERMES_WORKER_REPO", str(Path.home() / ".hermes/hermes-agent")))
    if not (runtime / "run_agent.py").is_file():
        raise ValueError("Installed Hermes runtime is missing")
    profile = job / "hermes-runtime"
    profile.mkdir(mode=0o700, exist_ok=False)
    isolated = {
        "model": {"default": state["model"], "provider": state["provider"], "base_url": config["base"]},
        "agent": {"max_turns": 24, "api_max_retries": 1},
        "fallback_model": {}, "fallback_providers": [], "mcp_servers": {}, "hooks": {},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "skills": {"auto_review": False}, "curator": {"enabled": False},
        "compression": {"enabled": False}, "checkpoints": {"enabled": False},
        "terminal": {"env_type": "local", "cwd": state["project"]},
        "approvals": {"mode": "manual", "cron_mode": "deny"},
    }
    # Profile has behavioral settings only, never credentials.
    (profile / "config.yaml").write_text(yaml.safe_dump(isolated))
    (profile / "config.yaml").chmod(0o600)
    for key in ("HERMES_YOLO_MODE", "HERMES_ACCEPT_HOOKS", "HERMES_IGNORE_USER_CONFIG", "HERMES_SESSION_SOURCE"):
        os.environ.pop(key, None)
    os.environ.update(HERMES_HOME=str(profile), TERMINAL_CWD=state["project"], TERMINAL_ENV="local")
    sys.path.insert(0, str(runtime))
    os.chdir(state["project"])
    notes = []

    def deny_approval(*args, **kwargs):
        notes.append("Hermes requested an interactive approval; the host must handle the blocked action.")
        return "deny"

    with contextlib.redirect_stdout(sys.stderr):
        from run_agent import AIAgent
        from tools.terminal_tool import set_approval_callback
        set_approval_callback(deny_approval)
        reasoning = None if state["effort"] == "provider-default" else {"enabled": True, "effort": state["effort"]}
        # Forward supported GLM parameters explicitly; also pass them through the
        # native reasoning adapter so the selected effort survives payload building.
        overrides = {} if reasoning is None else {"extra_body": {"thinking": {"type": "enabled"}, "reasoning_effort": state["effort"]}}
        agent = AIAgent(base_url=config["base"], api_key=config["secret"], provider=state["provider"],
                        api_mode="chat_completions", model=state["model"], reasoning_config=reasoning,
                        request_overrides=overrides, max_iterations=24, tool_delay=0,
                        enabled_toolsets=["file"] if state["mode"] == "plan" else ["file", "terminal"],
                        skip_context_files=True, skip_memory=True, load_soul_identity=False,
                        save_trajectories=False, quiet_mode=True, verbose_logging=False,
                        fallback_model={}, checkpoints_enabled=False, session_id="bridge_" + state["id"])
        allowed = {"read_file", "search_files"}
        if state["mode"] != "plan":
            allowed.update(("write_file", "patch", "terminal", "process"))
        agent.tools = [t for t in (agent.tools or []) if t["function"]["name"] in allowed]
        agent.valid_tool_names = {t["function"]["name"] for t in agent.tools}
        raw = agent.run_conversation(user_message=(job / "prompt.md").read_text() + "\nTask card:\n" + (job / "task.md").read_text())
        set_approval_callback(None)
    if raw.get("failed") or raw.get("error") or raw.get("partial") or raw.get("interrupted") or not raw.get("completed"):
        notes.append("Hermes did not complete normally; inspect the local job logs and partial edits.")
    if raw.get("model") != state["model"] or raw.get("provider") != state["provider"]:
        notes.append("Hermes reported a model/provider different from the dispatched selection.")
    response = raw.get("final_response") or ""
    if not response.strip() or response.strip() == "(empty)":
        notes.append("Hermes returned no final text.")
    result = {"jobId": state["id"], "worker": "hermes", "sessionId": agent.session_id,
              "response": (response or "; ".join(notes)).replace(config["secret"], "[redacted]"),
              "notes": notes, "providerLabel": "Hermes / configured " + state["provider"],
              "model": {"providerId": state["provider"], "modelId": state["model"], "options": {"reasoningLevel": state["effort"]}},
              "usage": {"inputTokens": raw.get("input_tokens"), "outputTokens": raw.get("output_tokens"),
                        "totalTokens": raw.get("total_tokens"), "reasoningTokens": raw.get("reasoning_tokens"),
                        "cacheReadTokens": raw.get("cache_read_tokens"), "modelRequestCount": raw.get("api_calls")},
              "projection": {"status": "error" if notes else "idle"}}
    output = job / "adapter-result.json"
    output.write_text(json.dumps(result, ensure_ascii=False))
    output.chmod(0o600)


if __name__ == "__main__":
    try:
        cfg = settings()
        if sys.argv[1] == "--destination":
            print(json.dumps({"provider": cfg["provider"], "endpoint": cfg["base"]}))
            sys.exit(0)
        if sys.argv[1] != "--models":
            state = json.loads((Path(sys.argv[1]) / "state.json").read_text())
            if state.get("destination") and state["destination"] != {"provider": cfg["provider"], "endpoint": cfg["base"]}:
                raise ValueError("Inference destination changed before Hermes startup; prepare again.")
        available = catalog(cfg)
        if sys.argv[1] == "--models":
            print(json.dumps(available, ensure_ascii=False))
        else:
            run_job(Path(sys.argv[1]), cfg, available)
    except Exception as error:
        # Do not serialize provider exception bodies (they can contain sensitive request metadata).
        safe = str(error) if isinstance(error, ValueError) else type(error).__name__ + ": worker failed; inspect local logs."
        if "cfg" in globals():
            safe = safe.replace(cfg["secret"], "[redacted]")
        print("Hermes adapter: " + safe, file=sys.stderr)
        sys.exit(1)
