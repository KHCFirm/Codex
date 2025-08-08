# Spreadsheet Note Exporter

This project converts a spreadsheet of project notes into individual Word and PDF documents.

## Usage

```bash
pip install -r requirements.txt
python export_notes.py input.csv output_directory
```

The script reads `input.csv`, filters for project types `Personal Injury`, `Workers' Compensation`, and
`Master Multi - PI & WC`, groups entries by `Project ID`, and writes a `.docx` and `.pdf` for each project.
All text in the generated Word documents uses font size 8.
