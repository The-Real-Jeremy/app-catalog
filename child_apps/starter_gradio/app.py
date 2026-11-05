"""Gradio starter for the App-ception (pre-installed Gradio).

Gradio builds absolute URLs for its API from its root path; the catalog sets
GRADIO_ROOT_PATH=/apps/<name> so they stay under the prefix.
"""
import os

import gradio as gr


def shout(text: str, times: int) -> str:
    text = (text or "").strip() or "hello from the catalog"
    return " ".join([text.upper() + "!"] * int(times))


with gr.Blocks(title="Gradio starter", theme=gr.themes.Soft()) as demo:
    gr.Markdown(f"## Gradio starter\nEvent round-trips through the catalog proxy · root `{os.environ.get('GRADIO_ROOT_PATH', '/')}`")
    with gr.Row():
        inp = gr.Textbox(label="Say something", value="hello")
        times = gr.Slider(1, 5, value=2, step=1, label="Times")
    out = gr.Textbox(label="Gradio answered")
    gr.Button("Shout", variant="primary").click(shout, [inp, times], out)

demo.launch()
