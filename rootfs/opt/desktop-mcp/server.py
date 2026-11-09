"""Desktop-control MCP server: screenshots, xdotool input, wmctrl windows, AT-SPI tree."""
import subprocess
import tempfile

import pyatspi
from mcp.server.fastmcp import FastMCP, Image

mcp = FastMCP("desktop")


def run(*cmd: str) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or f"{cmd[0]} failed")
    return r.stdout.strip()


@mcp.tool()
def screenshot() -> Image:
    """Capture the full desktop as PNG."""
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        run("scrot", "-o", "-z", f.name)
        return Image(path=f.name)


@mcp.tool()
def click(x: int, y: int, button: int = 1, double: bool = False) -> str:
    """Click at screen pixel coordinates. button: 1 left, 2 middle, 3 right."""
    run("xdotool", "mousemove", str(x), str(y))
    run("xdotool", "click", *(["--repeat", "2", "--delay", "80"] if double else []), str(button))
    return f"clicked {x},{y}"


@mcp.tool()
def type_text(text: str) -> str:
    """Type text into the focused window."""
    run("xdotool", "type", "--delay", "20", "--", text)
    return "typed"


@mcp.tool()
def key(keys: str) -> str:
    """Press a key or combo, xdotool syntax, e.g. 'Return', 'ctrl+l', 'alt+F4'."""
    run("xdotool", "key", keys)
    return f"pressed {keys}"


@mcp.tool()
def list_windows() -> str:
    """List windows: id, desktop, host, title."""
    return run("wmctrl", "-l")


@mcp.tool()
def focus_window(title: str) -> str:
    """Focus the first window whose title contains the given text."""
    run("wmctrl", "-a", title)
    return f"focused {title}"


@mcp.tool()
def launch(command: str) -> str:
    """Start a GUI program detached on the desktop, e.g. 'xfce4-terminal'."""
    subprocess.Popen(command, shell=True, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return f"started {command}"


def _walk(node, depth, max_depth, out):
    try:
        name, role = node.name, node.getRoleName()
        box = ""
        try:
            e = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            box = f" @{e.x},{e.y} {e.width}x{e.height}"
        except Exception:
            pass
        out.append(f"{'  ' * depth}{role} {name!r}{box}")
        if depth < max_depth:
            for child in node:
                if child is not None:
                    _walk(child, depth + 1, max_depth, out)
    except Exception:
        pass


@mcp.tool()
def a11y_tree(app: str = "", max_depth: int = 6) -> str:
    """Accessibility tree of native apps (GTK/Qt). Lists roles, names, screen boxes.
    app: substring filter on application name; empty lists app names only."""
    desktop = pyatspi.Registry.getDesktop(0)
    apps = [a for a in desktop if a is not None]
    if not app:
        return "\n".join(a.name for a in apps)
    out: list[str] = []
    for a in apps:
        if app.lower() in a.name.lower():
            _walk(a, 0, max_depth, out)
    return "\n".join(out) or f"no app matching {app!r}"


@mcp.tool()
def a11y_click(name: str, role: str = "", app: str = "") -> str:
    """Activate a native UI element by accessible name (substring, case-insensitive).
    role: optional role filter such as 'menu item', 'push button', 'menu'.
    Uses the element's default action, else clicks its center."""
    desktop = pyatspi.Registry.getDesktop(0)
    for a in desktop:
        if a is None or (app and app.lower() not in a.name.lower()):
            continue
        hit = pyatspi.findAllDescendants(
            a, lambda n: name.lower() in (n.name or "").lower()
            and (not role or n.getRoleName() == role)
            and n.getState().contains(pyatspi.STATE_SHOWING))
        if hit:
            n = hit[0]
            try:
                n.queryAction().doAction(0)
                return f"activated {n.getRoleName()} {n.name!r}"
            except Exception:
                e = n.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                return click(e.x + e.width // 2, e.y + e.height // 2)
    return f"no visible element named {name!r}"


if __name__ == "__main__":
    mcp.run()
