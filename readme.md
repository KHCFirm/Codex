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

Run the web application:

```bash
python web_app.py
```

Then open [http://localhost:5000](http://localhost:5000) in your browser. Drag and drop one or more PDF files onto the page and the parsed JSON will appear below the drop area.
