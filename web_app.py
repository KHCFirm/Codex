from __future__ import annotations

"""Simple Streamlit interface for ``pdf_claim_parser``."""

from pathlib import Path
import tempfile

import streamlit as st

from pdf_claim_parser import parse_file


st.set_page_config(page_title="Claim PDF Parser", layout="wide")
st.title("Claim PDF Parser")
st.sidebar.header("Instructions")
st.sidebar.write("Upload one or more claim PDFs to parse them.")

uploaded_files = st.file_uploader(
    "Upload claim PDFs", type="pdf", accept_multiple_files=True
)

if uploaded_files:
    for uploaded in uploaded_files:
        if not uploaded:
            continue
        with tempfile.NamedTemporaryFile(delete=True, suffix=".pdf") as tmp:
            tmp.write(uploaded.read())
            tmp.flush()
            result = parse_file(Path(tmp.name))
        with st.expander(uploaded.name):
            meta = {k: v for k, v in result.items() if k != "service_lines"}
            st.json(meta)
            lines = result.get("service_lines") or []
            if lines:
                st.table(lines)

if __name__ == "__main__":
    st.write("Run this app with: streamlit run web_app.py")
