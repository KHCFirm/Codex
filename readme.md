# Claim Parser

This project extracts key information from healthcare claim PDFs. It supports
HCFA-1500 claim forms and Explanation of Benefits (EOB) documents and includes a
Streamlit web application for easy upload and parsing.

## Setup

Install dependencies:

```bash
pip install -r requirements.txt
```

For OCR support you also need Tesseract and poppler utilities available on
your system. On Ubuntu:

```bash
apt-get update && apt-get install -y tesseract-ocr poppler-utils
```

## Command-line usage

```bash
python pdf_claim_parser.py "path/to/*.pdf"
```

## Web UI

Launch the Streamlit interface:

```bash
streamlit run web_app.py
```

Open the provided URL in your browser, upload one or more PDF files and download
the parsed results as a JSON file.
