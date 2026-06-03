var fs = require('fs');
var games = ['adventure-island','baseball-stars','battletoads','blades-of-poop','bucky-ohare','arkanoid-mft','bomberman-poop','blocks-burg'];
games.forEach(function(g) {
  try {
    var src = fs.readFileSync('/var/www/tasern/games/' + g + '.html', 'utf8');
    var scripts = src.match(/<script>[\s\S]*?<\/script>/g);
    if (!scripts) { console.log(g + ': NO SCRIPT TAGS'); return; }
    var lastScript = scripts[scripts.length - 1];
    var code = lastScript.replace(/<\/?script>/g, '');
    code = code.replace(/TAS\./g, 'TAS_').replace(/NftLoader\./g, 'NL_');
    try {
      new Function(code);
      console.log(g + ': SYNTAX OK');
    } catch(e) {
      console.log(g + ': SYNTAX ERROR - ' + e.message);
    }
  } catch(e) {
    console.log(g + ': FILE ERROR - ' + e.message);
  }
});
