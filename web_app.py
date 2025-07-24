from __future__ import annotations

from flask import Flask, render_template, request, jsonify
from pathlib import Path
import tempfile

from pdf_claim_parser import parse_file

app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload():
    files = request.files.getlist('files')
    results = []
    for f in files:
        if not f:
            continue
        with tempfile.NamedTemporaryFile(delete=True, suffix='.pdf') as tmp:
            f.save(tmp.name)
            results.append(parse_file(Path(tmp.name)))
    return jsonify(results)

if __name__ == '__main__':
    app.run(debug=True)
