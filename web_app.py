from __future__ import annotations

"""Simple Streamlit interface for ``pdf_claim_parser``."""

from pathlib import Path
import tempfile

import streamlit as st

from pdf_claim_parser import parse_file


st.title("Claim PDF Parser")

uploaded_files = st.file_uploader(
    "Upload claim PDFs", type="pdf", accept_multiple_files=True
)

if uploaded_files:
    results = []
    for uploaded in uploaded_files:
        if not uploaded:
            continue
        with tempfile.NamedTemporaryFile(delete=True, suffix=".pdf") as tmp:
            tmp.write(uploaded.read())
            tmp.flush()
            results.append(parse_file(Path(tmp.name)))
    st.json(results)

if __name__ == "__main__":
    st.write("Run this app with: streamlit run web_app.py")
