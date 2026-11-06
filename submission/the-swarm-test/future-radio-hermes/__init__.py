"""Future Radio as a Hermes Agent plugin: script to screen in seven tools, plus the acceptance test."""
try:
    from . import pipeline, schemas, tools
except ImportError:  # imported outside a package, e.g. by pytest's collector; Hermes imports it as a package
    pipeline = schemas = tools = None


def _has_playwright():
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def register(ctx):
    for s in schemas.ALL:
        ctx.register_tool(name=s["name"], toolset="future_radio", schema=s, handler=getattr(tools, s["name"]),
                          check_fn=_has_playwright if s["name"] == "fr_cards" else None)
