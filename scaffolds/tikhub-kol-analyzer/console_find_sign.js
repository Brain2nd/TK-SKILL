// === Find fm-sign generation in page JS ===
// Run this on a FastMoss detail page

// Method 1: Search global scope for functions with 'sign' in name
var signKeys = [];
for (var k in window) {
  try {
    if (k.toLowerCase().indexOf('sign') > -1 || k.toLowerCase().indexOf('fm') > -1) {
      signKeys.push(k);
    }
  } catch(e) {}
}
console.log('Global keys with sign/fm:', signKeys);

// Method 2: Check webpack chunks for fm-sign logic
var scripts = document.querySelectorAll('script[src]');
var chunkUrls = [];
for (var i = 0; i < scripts.length; i++) {
  var src = scripts[i].src;
  if (src.indexOf('sign') > -1 || src.indexOf('fm') > -1 || src.indexOf('crypto') > -1) {
    chunkUrls.push(src);
  }
}
console.log('Scripts with sign/fm/crypto:', chunkUrls);

// Method 3: Look for fmSign or similar in all inline scripts
var inlineScripts = document.querySelectorAll('script:not([src])');
var found = [];
for (var i2 = 0; i2 < inlineScripts.length; i2++) {
  var text = inlineScripts[i2].textContent || '';
  if (text.indexOf('fm-sign') > -1 || text.indexOf('fmSign') > -1 || text.indexOf('fmsign') > -1) {
    found.push(text.substring(0, 500));
  }
}
console.log('Inline scripts with fm-sign:', found.length);

// Method 4: Search React fiber for memoized values containing sign
var root = document.getElementById('__next');
if (root) {
  var key = Object.keys(root).find(function(k) { return k.indexOf('__reactFiber') === 0; });
  if (key) {
    console.log('React fiber key found:', key);
  }
}

console.log('\n--- Also check: Go to Network tab, filter "authorContact",');
console.log('right-click the request -> Copy -> Copy as fetch');
console.log('Paste it here and I can extract the sign generation pattern.');
