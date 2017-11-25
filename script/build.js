'use strict';

var fs = require('fs');
var path = require('path');
var xtend = require('xtend');
var negate = require('negate');
var hidden = require('is-hidden');
var iso6393 = require('iso-639-3');
var speakers = require('speakers');
var unified = require('unified');
var stringify = require('remark-stringify');
var u = require('unist-builder');
var format = require('format');
var author = require('parse-author');
var human = require('human-format');
var alpha = require('alpha-sort');
var information = require('udhr').information();
var declarations = require('udhr').json();
var trigrams = require('trigrams').min();
var scripts = require('unicode-7.0.0').Script;
var customFixtures = require('./custom-fixtures');
var overrides = require('./udhr-overrides');
var exclude = require('./udhr-exclude');

var core = path.join(__dirname, '..');
var root = path.join(core, 'packages');
var mono = require(path.join(__dirname, '..', 'package.json'));

/* Persian (fas, macrolanguage) contains Western Persian (pes)
 * and Dari (prs).  They’re so similar in UDHR that using both
 * will result in incorrect results, so add the macrolanguage
 * instead. (note: prs and pes are blacklisted) */
speakers = xtend(speakers, {
  fas: speakers.prs + speakers.pes
});

var expressions = createExpressions();
var topLanguages = createTopLanguages();
var doc = fs.readFileSync(path.join(root, 'franc', 'index.js'), 'utf8');

fs
  .readdirSync(root)
  .filter(negate(hidden))
  .forEach(generate);

function generate(basename) {
  var base = path.join(root, basename);
  var pack = JSON.parse(fs.readFileSync(path.join(base, 'package.json')));
  var threshold = pack.threshold;
  var support = [];
  var regularExpressions = {}; /* Ha! */
  var perScript = {};
  var data = {};
  var list = topLanguages;
  var fixtures;
  var byScript;
  var includedlanguages = pack.includedlanguages || [];

  if (!threshold) {
    return;
  }

  console.log();
  console.log(pack.name + ', threshold: ' + threshold);

  if (threshold !== -1) {
    list = list.filter(function (info) {
      return info.speakers >= threshold;
    });
  }

  if (includedlanguages.length > 0) {
    list = list.filter(function (info) {
      return includedlanguages.indexOf(info.iso6393) > -1;
    });
  }

  byScript = createTopLanguagesByScript(list);

  Object.keys(byScript).forEach(function (script) {
    var languages = byScript[script].filter(function (info) {
      return [
        /* Ignore `npi` (Nepali (individual language)): `npe`
         * (Nepali (macrolanguage)) is also included. */
        'npi',
        /* Ignore `yue`, it uses the Han script, just like `cmn`,
         * but if both are turned on, both will be ignored as Trigrams
         * don’t work on Han characters (cmn has 830m speakers, so
         * that’s the preferred choice). */
        'yue'
      ].indexOf(info.iso6393) === -1;
    });

    if (languages.length > 1) {
      if (!regularExpressions[script]) {
        regularExpressions[script] = expressions[script];
      }

      perScript[script] = languages;
    } else {
      support.push(languages[0]);
      regularExpressions[languages[0].iso6393] = expressions[script];
    }
  });

  Object
    .keys(perScript)
    .forEach(function (script) {
      var scriptObject = {};

      data[script] = scriptObject;

      perScript[script].forEach(function (info) {
        if (trigrams[info.udhr]) {
          support.push(info);
          scriptObject[info.iso6393] = trigrams[info.udhr].concat().reverse().join('|');
        } else {
          console.log('  Ignoring language without trigrams: ' + info.iso6393 + ' (' + info.name + ')');
        }
      });
    });

  /* Push Japanese. */
  regularExpressions.jpn = new RegExp(
    expressions.Hiragana.source + '|' +
    expressions.Katakana.source,
    'g'
  );

  support.sort(sort);

  fs.writeFileSync(path.join(base, 'expressions.js'), generateExpressions(regularExpressions));
  fs.writeFileSync(path.join(base, 'data.json'), JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(base, 'readme.md'), generateReadme(pack, support));

  if (pack.name !== mono.name) {
    fs.writeFileSync(
      path.join(base, 'index.js'),
      '// This file is generated by `build.js`\n' + doc
    );
  }

  console.log('✓ ' + pack.name + ' w/ ' + list.length + ' languages');

  if (pack.name !== mono.name) {
    return;
  }

  console.log();
  console.log('Creating fixtures');

  fixtures = {};

  support.forEach(function (language) {
    var udhrKey = language.udhr;
    var fixture;

    if (udhrKey in customFixtures) {
      fixture = customFixtures[udhrKey];
    } else if (udhrKey in declarations) {
      if (declarations[udhrKey].preamble && declarations[udhrKey].preamble.para) {
        fixture = declarations[udhrKey].preamble.para;
      } else if (declarations[udhrKey].note && declarations[udhrKey].note[0]) {
        fixture = declarations[udhrKey].note[0].para;
      }
    }

    if (!fixture) {
      console.log(
        '  Could not access preamble or note for `' +
        language.iso6393 + '` (' + udhrKey + '). ' +
        'No fixture is generated.'
      );

      fixture = '';
    }

    fixtures[udhrKey] = {
      iso6393: language.iso6393,
      fixture: fixture.slice(0, 1000)
    };
  });

  fs.writeFileSync(
    path.join(core, 'test', 'fixtures.json'),
    JSON.stringify(fixtures, 0, 2) + '\n'
  );

  console.log('✓ fixtures');
}

function generateExpressions(expressions) {
  return [
    '// This file is generated by `build.js`.',
    'module.exports = {',
    '  ' + Object
      .keys(expressions)
      .map(function (script) {
        return script + ': ' + expressions[script];
      })
      .join(',\n  '),
    '};',
    ''
  ].join('\n');
}

function generateReadme(pack, list) {
  var counts = count(list);
  var threshold = pack.threshold;
  var licensee = author(pack.author);
  var tree = u('root', [
    u('html', '<!--This file is generated by `build.js`-->'),
    u('heading', {depth: 1}, [u('text', pack.name)]),
    u('blockquote', [
      u('paragraph', [u('text', pack.description + '.')])
    ]),
    u('paragraph', [u('text', format(
      'Built with support for %s languages%s.',
      list.length,
      threshold === -1 ? '' : ' (' + human(threshold, {separator: ''}) + ' or more speakers)'
    ))]),
    u('paragraph', [
      u('text', 'View the '),
      u('link', {url: mono.repository}, [u('text', 'monorepo')]),
      u('text', ' for more packages and\nusage information.')
    ]),
    u('heading', {depth: 2}, [u('text', 'Install')]),
    u('paragraph', [u('text', 'npm:')]),
    u('code', {lang: 'sh'}, 'npm install ' + pack.name),
    u('heading', {depth: 2}, [u('text', 'Support')]),
    u('paragraph', [u('text', 'This build supports the following languages:')]),
    u('table', {align: []}, [header()].concat(list.map(row))),
    u('heading', {depth: 2}, [u('text', 'License')]),
    u('paragraph', [
      u('link', {url: mono.repository + '/blob/master/LICENSE'}, [u('text', mono.license)]),
      u('text', ' © '),
      u('link', {url: licensee.url}, [u('text', licensee.name)])
    ])
  ]);

  return unified().use(stringify).stringify(tree);

  function row(info) {
    return u('tableRow', [
      u('tableCell', [
        u('link', {
          url: 'http://www-01.sil.org/iso639-3/documentation.asp?id=' + info.iso6393,
          title: null
        }, [u('inlineCode', info.iso6393)])
      ]),
      u('tableCell', [
        u('text', info.name + (counts[info.iso6393] === 1 ? '' : ' (' + info.script + ')'))
      ]),
      u('tableCell', [
        u('text', isNaN(info.speakers) ? 'unknown' : human(info.speakers, {separator: '', decimals: 0}))
      ])
    ]);
  }

  function header() {
    return u('tableRow', [
      u('tableCell', [u('text', 'Code')]),
      u('tableCell', [u('text', 'Name')]),
      u('tableCell', [u('text', 'Speakers')])
    ]);
  }
}

function count(list) {
  var map = {};
  list.forEach(function (info) {
    map[info.iso6393] = (map[info.iso6393] || 0) + 1;
  });
  return map;
}

/* Get all values at `key` properties in `object`. */
function all(object, key) {
  var results = [];
  var property;
  var value;

  for (property in object) {
    value = object[property];

    if (property === key) {
      results.push(value);
    } else if (typeof value === 'object') {
      results = results.concat(all(value, key));
    }
  }

  return results;
}

/* Get which scripts are used for a given UDHR code. */
function scriptInformation(code) {
  var declaration = declarations[code];
  var content = all(declaration, 'para').join('');
  var length = content.length;
  var scriptInformation = {};

  Object.keys(expressions).forEach(function (script) {
    var count;

    /* Ignore: unimportant for our goal, scripts. */
    if (script === 'Common' || script === 'Inherited') {
      return;
    }

    count = content.match(expressions[script]);
    count = (count ? count.length : 0) / length;
    count = Math.round(count * 100) / 100;

    if (count && count > 0.05) {
      scriptInformation[script] = count;
    }
  });

  return scriptInformation;
}

/* Sort a list of languages by most-popular. */
function sort(a, b) {
  var diff = b.speakers - a.speakers;

  if (diff > 0 || diff < 0) {
    return diff;
  }

  if (b.speakers === a.speakers) {
    return alpha.asc(a.name, b.name);
  }

  return b.speakers ? 1 : -1;
}

function createExpressions() {
  var res = {};
  scripts.forEach(function (script) {
    var expression = require('unicode-7.0.0/Script/' + script + '/regex.js');
    res[script] = new RegExp(expression.source, 'g');
  });
  return res;
}

function createTopLanguages() {
  var top = iso6393
    .map(function (info) {
      return xtend(info, {speakers: speakers[info.iso6393]});
    })
    .filter(function (info) {
      var code = info.iso6393;
      var name = info.name;

      if (exclude.indexOf(code) !== -1) {
        console.log('Ignoring unsafe language `' + code + '` (' + name + ')');
        return false;
      }

      if (info.type === 'special') {
        console.log('Ignoring special code `' + code + '` (' + name + ')');
        return false;
      }

      return true;
    });

  top.forEach(function (info) {
    var code = info.iso6393;
    var udhrs = getUDHRKeysfromISO(code);

    info.udhr = udhrs.pop();

    if (udhrs.length !== 0) {
      udhrs.forEach(function (udhr) {
        top.push(xtend(info, {udhr: udhr}));
      });
    }
  });

  top.forEach(function (info) {
    var code = info.iso6393;
    var scripts = scriptInformation(info.udhr);

    /* Languages without (accessible) UDHR declaration.
     * No trigram, and no custom script, available for:
     * - awa (Awadhi): Devanagari, Kaithi, Persian;
     * - snd (Sindhi): Arabic, Devanagari, Khudabadi, and more;
     * - hne (Chhattisgarhi): Devanagari;
     * - asm (Assamese): Assamese (Bengali + two other characters*);
     * - koi (Komi-Permyak): Cyrillic;
     * - raj (Rajasthani): Devanagari;
     * - mve (Marwari): Devanagari, and Mahajani (which is in unicode*);
     * - bjj (Kanauji): Devanagari;
     * - kmr (Northern Kurdish): Latin (main); Perso-Arabic;
     * - kas (Kashmiri): Perso-Arabic, Devanagari, Sharada.
     * - shn (Shan): A Shan script exists, but nearly no one can read it*.
     * - gbm (Garhwali): Devanagari
     * - dyu (Dyula): N'Ko, Latin, Arabic
     * - ksw (S'gaw Karen): Burmese
     * - gno (Northern Gondi): Devanagari, Telugu
     * - bgp (Eastern Balochi): Urdu Arabic, Arabic
     * - unr (Mundari): ?
     * - hoc (Ho): Ol Chiki, Devanagari, Varang Kshiti
     * - pwo (Pwo Western Karen): Burmese
     *
     * *: future interest?
     */
    if (code === 'tel') {
      scripts.Telugu = 0.8;
    } else if (code === 'ori') {
      scripts.Oriya = 0.8;
    } else if (code === 'sin') {
      scripts.Sinhala = 0.8;
    } else if (code === 'sat') {
      scripts.Ol_Chiki = 0.8;
    } else if (code === 'jpn') {
      /* Japanese is different. */
      scripts = {'Hiragana, Katakana, and Han': 0.8};
    }

    info.script = Object.keys(scripts);
  });

  top = top.filter(function (info) {
    var scripts = info.script;
    var ignore = !trigrams[info.udhr] && scripts.length === 0;

    info.script = scripts[0];

    if (scripts.length > 1) {
      throw new Error(
        'Woops, I found a language which uses more than ' +
        'one script. Franc is not build for that. Exiting.'
      );
    }

    if (ignore && info.speakers && info.speakers > 1e6) {
      console.log(
        'Ignoring language with neither trigrams nor ' +
        'scripts: %s (%s, %s)',
        info.iso6393,
        info.name,
        info.speakers
      );
    }

    return !ignore;
  });

  return top.sort(sort);
}

function createTopLanguagesByScript(top) {
  var scripts = {};

  top.forEach(function (info) {
    var script = info.script;

    if (!scripts[script]) {
      scripts[script] = [];
    }

    scripts[script].push(info);
  });

  return scripts;
}

/* Get UDHR codes for an ISO6393 code. */
function getUDHRKeysfromISO(iso) {
  var udhrs = [];

  if (iso in overrides) {
    return overrides[iso];
  }

  Object.keys(information).forEach(function (code) {
    var info = information[code];

    if (info.ISO === iso || info.code === iso) {
      udhrs.push(code);
    }
  });

  if (udhrs.length === 1) {
    return udhrs;
  }

  /* Pick the main UDHR. */
  if (udhrs.indexOf(iso) !== -1) {
    return [iso];
  }

  return udhrs;
}
