// Step 1: Load CSV file, parse candidates from it
var inp = document.createElement('input');
inp.type = 'file';
inp.onchange = function(e) {
  var r = new FileReader();
  r.onload = function() {
    var lines = r.result.split('\n');
    var headers = lines[0].replace(/^﻿/, '').split(',');
    window.__candidates = [];
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var vals = lines[i].split(',');
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = (vals[j] || '').replace(/^"|"$/g, '');
      }
      window.__candidates.push(obj);
    }
    console.log('Loaded ' + window.__candidates.length + ' candidates. Paste console_emails.js now.');
  };
  r.readAsText(e.target.files[0]);
};
inp.click();
