"""Send a Python Slack app's Web API traffic to Chatter instead of slack.com.

slack_sdk has no environment variable for its API address, so put this
directory on PYTHONPATH and set CHATTER_SLACK_API_URL (for example
https://chatter.example.com/api/slack/). Python imports ``sitecustomize`` at
startup; from then on every slack_sdk Web API client defaults to that address,
and so does Socket Mode, whose WebSocket URL comes from ``apps.connections.open``.
Raw aiohttp posts to ``https://slack.com/api/`` (some apps send outside the
SDK) are redirected too. The app's own code is not touched.
"""

import os

_TARGET = os.environ.get("CHATTER_SLACK_API_URL", "")
_SLACK = "https://slack.com/api/"


def _default_base_url(cls):
    original = cls.__init__
    if getattr(original, "_chatter", False):
        return

    def __init__(self, *args, **kwargs):
        # base_url is the second positional parameter of both clients, after token.
        if len(args) < 2:
            kwargs.setdefault("base_url", _TARGET)
        original(self, *args, **kwargs)
        if getattr(self, "base_url", "") == _SLACK:
            self.base_url = _TARGET

    __init__._chatter = True
    cls.__init__ = __init__


def _redirect_sdk():
    try:
        from slack_sdk.web.async_base_client import AsyncBaseClient
        from slack_sdk.web.base_client import BaseClient
    except ImportError:
        return
    _default_base_url(BaseClient)
    _default_base_url(AsyncBaseClient)


def _redirect_aiohttp():
    try:
        import aiohttp
    except ImportError:
        return
    original = aiohttp.ClientSession._request
    if getattr(original, "_chatter", False):
        return

    async def _request(self, method, url, *args, **kwargs):
        text = str(url)
        if text.startswith(_SLACK):
            url = _TARGET + text[len(_SLACK):]
        return await original(self, method, url, *args, **kwargs)

    _request._chatter = True
    aiohttp.ClientSession._request = _request


if _TARGET:
    if not _TARGET.endswith("/"):
        _TARGET += "/"
    _redirect_sdk()
    _redirect_aiohttp()
