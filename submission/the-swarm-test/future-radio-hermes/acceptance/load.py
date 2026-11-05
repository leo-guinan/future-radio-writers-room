"""Load the repo as the plugin package (future_radio) without installing it into Hermes."""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def plugin():
    if "future_radio" in sys.modules:
        return sys.modules["future_radio"]
    spec = importlib.util.spec_from_file_location("future_radio", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["future_radio"] = mod
    spec.loader.exec_module(mod)
    return mod


class FakeCtx:
    """Just enough of Hermes' plugin context to call register(ctx) and the handlers."""
    def __init__(self):
        self.tools = {}

    def register_tool(self, name, toolset, schema, handler, check_fn=None, override=False):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "check_fn": check_fn}
