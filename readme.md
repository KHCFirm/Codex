# Claim Parser

This project extracts key information from healthcare claim PDFs. It supports
HCFA-1500 claim forms and Explanation of Benefits (EOB) documents. Parsing logic
is implemented in both Python (for tests) and a modern React web application.

## Setup

Install the Python dependencies if you want to run the command-line utilities or
tests:

```bash
pip install -r requirements.txt
```

For OCR support you also need Tesseract and poppler utilities available on your
system. On Ubuntu:

```bash
apt-get update && apt-get install -y tesseract-ocr poppler-utils
```

## Command-line usage

```bash
python pdf_claim_parser.py "path/to/*.pdf"
```

## Web UI

A Vite + React + TypeScript frontend is located in the `web` directory. It uses
PDF.js to classify and extract data directly in the browser. To start the
development server:

```bash
cd web
npm install
npm run dev
```

Open the URL printed by Vite and upload one or more PDF files. Parsed results
can be downloaded as a JSON file.
