const { execSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const APP_ID = 'com.capm.userattrs'
const dist   = path.resolve('dist')
const out    = path.join(dist, `${APP_ID}.zip`)

if (fs.existsSync(out)) fs.unlinkSync(out)

if (process.platform === 'win32') {
    execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${dist}\\*' -DestinationPath '${out}' -Force"`,
        { stdio: 'inherit' }
    )
} else {
    execSync(`cd "${dist}" && zip -r "${out}" .`, { shell: '/bin/sh', stdio: 'inherit' })
}

console.log(`Created ${out}`)
