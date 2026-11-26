// Before the first paint: the language, as the page chooses it. The theme is `skin/theme.js`'s,
// which the build inlines beside this script.
(function () {
  var root = document.documentElement;
  var isLanguage = function (value) {
    return value === 'en' || value === 'fr';
  };
  // the address first, `?lng=`, then the visitor's choice this page stored under `language`, its
  // origin's own, then the browser's languages, then English
  var language = null;
  try {
    var asked = new URLSearchParams(window.location.search).get('lng');
    if (isLanguage(asked)) {
      language = asked;
    }
  } catch (error) {
    language = null;
  }
  if (language === null) {
    try {
      var chosen = window.localStorage.getItem('language');
      if (isLanguage(chosen)) {
        language = chosen;
      }
    } catch (error) {
      language = null;
    }
  }
  if (language === null) {
    var tags = navigator.languages || [navigator.language || ''];
    for (var index = 0; index < tags.length; index += 1) {
      var base = String(tags[index]).split('-')[0].toLowerCase();
      if (isLanguage(base)) {
        language = base;
        break;
      }
    }
  }
  if (language === null) {
    language = 'en';
  }
  root.lang = language === 'fr' ? 'fr-CA' : 'en-CA';
  // the page holds English; another language is swapped in at the end of the body, and nothing is
  // painted before
  if (language !== 'en') {
    root.setAttribute('data-swapping', '');
  }
  root.setAttribute('data-language', language);
})();
