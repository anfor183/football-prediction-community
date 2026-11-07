const Jimp = require('jimp').Jimp;
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

const input = path.join(__dirname, 'resources', 'icon.png');
const pngOut = path.join(__dirname, 'resources', 'icon_fixed.png');
const icoOut = path.join(__dirname, 'resources', 'icon.ico');

Jimp.read(input, (err, image) => {
  if (err) {
    console.error('Jimp read err', err);
    process.exit(1);
  }
  image.getBuffer(Jimp.MIME_PNG, (err2, buffer) => {
    if (err2) {
      console.error('getBuffer err', err2);
      process.exit(1);
    }
    fs.writeFileSync(pngOut, buffer);
    pngToIco(pngOut)
      .then((buf) => {
        fs.writeFileSync(icoOut, buf);
        console.log('Created', icoOut);
      })
      .catch((err3) => {
        console.error('pngToIco err', err3);
        process.exit(1);
      });
  });
});
