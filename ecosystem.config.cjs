// PM2 ecosystem config — EduConsult OS
// Bu dosya deploy/ecosystem.config.cjs'e referans verir (yetkili kaynak).
// Production'da doğrudan `pm2 start` kullanmayın. Tek güvenli giriş noktası
// preflight korumalı deploy/deploy.sh dosyasıdır.

"use strict";

module.exports = require("./deploy/ecosystem.config.cjs");
