# Claim Parser

This project parses healthcare claim PDFs (HCFA-1500 claim forms and Explanation of Benefits documents). It now includes a small web interface for uploading PDFs via drag and drop.

## Setup

Install dependencies:

```bash
pip install -r requirements.txt
```

## Command-line usage

```bash
python pdf_claim_parser.py "path/to/*.pdf" --output results.json
```

## Web UI

Run the web application with Streamlit:

```bash
streamlit run web_app.py
```

Streamlit will display a local URL in the console. Open it in your browser, upload one or more PDF files and the parsed JSON will appear on the page.
