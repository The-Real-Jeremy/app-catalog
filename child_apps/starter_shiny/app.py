"""Shiny for Python starter for the App-ception (pre-installed Shiny).

Shiny keeps a websocket open per session and uses relative URLs for it.
"""
import numpy as np
from shiny import App, render, ui

app_ui = ui.page_fluid(
    ui.tags.style("body{background:#0f1420;color:#e8edf5;font-family:system-ui,sans-serif;padding:24px} .irs--shiny .irs-bar{background:#4f8ef7;border-color:#4f8ef7}"),
    ui.h2("Shiny starter"),
    ui.p("Inputs and outputs round-trip over Shiny's websocket, through the catalog proxy.", style="color:#a6b0c3"),
    ui.input_slider("n", "Sample size", 10, 500, 120),
    ui.output_text_verbatim("summary"),
)


def server(input, output, session):
    @render.text
    def summary():
        x = np.random.default_rng(3).normal(0, 1, input.n())
        return f"n={input.n()}  mean={x.mean():+.3f}  sd={x.std():.3f}"


app = App(app_ui, server)
