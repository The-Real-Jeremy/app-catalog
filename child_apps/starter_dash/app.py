"""Dash starter for the App Catalog (pre-installed Dash + Plotly).

Dash's browser code requests /_dash-layout, /_dash-update-component and its
JS bundles from `requests_pathname_prefix`; the catalog sets
DASH_REQUESTS_PATHNAME_PREFIX so those land under /apps/<name>/.
"""
import os

import numpy as np
import plotly.graph_objects as go
from dash import Dash, Input, Output, dcc, html

app = Dash(__name__, title="Dash starter")
server = app.server

app.layout = html.Div(
    style={"fontFamily": "system-ui, sans-serif", "padding": "28px 36px", "background": "#0f1420", "color": "#e8edf5", "minHeight": "100vh"},
    children=[
        html.H2("Dash starter", style={"margin": "0 0 4px"}),
        html.Div(f"Callbacks round-trip through the catalog proxy · base {os.environ.get('CATALOG_BASE_PATH', '/')}", style={"color": "#a6b0c3"}),
        html.Div(style={"marginTop": "22px", "maxWidth": "520px"}, children=[
            html.Label("Points"),
            dcc.Slider(id="n", min=10, max=200, step=10, value=60),
        ]),
        dcc.Graph(id="g", style={"marginTop": "10px", "height": "430px"}),
        html.Div(id="echo", style={"color": "#2d6cdf", "marginTop": "6px"}),
    ],
)


@app.callback(Output("g", "figure"), Output("echo", "children"), Input("n", "value"))
def draw(n):
    rng = np.random.default_rng(7)
    y = np.cumsum(rng.normal(0, 1, n))
    fig = go.Figure(go.Scatter(y=y, mode="lines", line={"color": "#4f8ef7", "width": 2}))
    fig.update_layout(template="plotly_dark", paper_bgcolor="#0f1420", plot_bgcolor="#141b2a", margin={"l": 40, "r": 20, "t": 20, "b": 40})
    return fig, f"callback answered for n={n}"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8050")), debug=False)
