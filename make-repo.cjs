// Writes the Homebrew Channel files for the IPK that build.sh just made.
// repo.json is the repository index; add its raw URL as a custom repository.
// It expects the IPK attached to the GitHub release tagged v<version>.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const here = __dirname;
const info = JSON.parse(fs.readFileSync(path.join(here, 'app', 'appinfo.json'), 'utf8'));
const ipkName = `${info.id}_${info.version}_all.ipk`;
const ipk = fs.readFileSync(path.join(here, 'build', ipkName));
const repo = 'https://github.com/Ripthulhu/pico-webos';
const raw = 'https://raw.githubusercontent.com/Ripthulhu/pico-webos/main';
const release = `${repo}/releases/download/v${info.version}`;

const manifest = {
  id: info.id,
  version: info.version,
  type: info.type,
  title: info.title,
  appDescription: "Pico's School, rebuilt in C and running as WebAssembly.",
  iconUri: `${raw}/app/largeIcon.png`,
  sourceUrl: repo,
  rootRequired: false,
  ipkUrl: `${release}/${ipkName}`,
  ipkHash: { sha256: crypto.createHash('sha256').update(ipk).digest('hex') },
  ipkSize: ipk.length,
};
const index = {
  paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1, prevUrl: null, nextUrl: null },
  packages: [{
    id: info.id,
    title: info.title,
    iconUri: manifest.iconUri,
    manifestUrl: `${release}/webosbrew.manifest.json`,
    manifest,
    pool: 'main',
    shortDescription: manifest.appDescription,
  }],
};
const json = v => JSON.stringify(v, null, 2) + '\n';
fs.writeFileSync(path.join(here, 'build', 'webosbrew.manifest.json'), json(manifest));
fs.writeFileSync(path.join(here, 'repo.json'), json(index));
console.log(`repo.json: ${ipkName}, ${ipk.length} bytes, sha256 ${manifest.ipkHash.sha256}`);
