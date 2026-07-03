// second-stage loader — deliberately obfuscated
const payload = atob("Y29uc29sZS5sb2coJ2hpJyk=");
eval(payload);

// character-code wall to hide a string from readers
const s = String.fromCharCode(104) + String.fromCharCode(101) + String.fromCharCode(108) + String.fromCharCode(108) + String.fromCharCode(111) + String.fromCharCode(32) + String.fromCharCode(119) + String.fromCharCode(111) + String.fromCharCode(114) + String.fromCharCode(108) + String.fromCharCode(100);
new Function(s)();
