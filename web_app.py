from __future__ import annotations

"""Streamlit interface for parsing HCFA/EOB PDFs."""

import json
from pathlib import Path
import tempfile

import streamlit as st

from pdf_claim_parser import parse_file


st.set_page_config(page_title="Healthcare Claim Parser", layout="wide")
st.title("Healthcare Claim Parser")

with st.sidebar:
    st.header("Instructions")
    st.markdown(
        "Upload HCFA-1500 or Explanation of Benefits PDFs and the application\n"
        "will attempt to extract common fields. Parsed results can be\n"
        "downloaded as a JSON file."
    )
    uploaded_files = st.file_uploader(
        "Upload PDF files", type="pdf", accept_multiple_files=True
    )

results = []
if uploaded_files:
    for uploaded in uploaded_files:
        if not uploaded:
            continue
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(uploaded.read())
            tmp.flush()
            result = parse_file(Path(tmp.name))
        results.append(result)
        with st.expander(f"{uploaded.name} ({result.get('doc_type')})"):
            meta = {k: v for k, v in result.items() if k != "service_lines"}
            st.json(meta)
            lines = result.get("service_lines") or []
            if lines:
                st.table(lines)

if results:
    json_data = json.dumps(results, indent=2)
    st.download_button("Download JSON", json_data, file_name="parsed_claims.json")

if __name__ == "__main__":
    st.write("Run this app with: streamlit run web_app.py")
