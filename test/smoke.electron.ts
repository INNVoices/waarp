import { app } from 'electron'
import { scanApps } from '../src/main/apps'
import { adapters, conflicts } from '../src/main/guard'
import { isAdmin } from '../src/main/ps'

app.whenReady().then(async () => {
  const t = Date.now()
  const apps = await scanApps()
  const ad = await adapters()
  console.log(JSON.stringify({
    admin: await isAdmin(),
    apps: apps.length, running: apps.filter(a => a.running).length, withIcon: apps.filter(a => a.icon).length,
    sample: apps.slice(0, 8).map(a => `${a.name} | ${a.matchDir ? 'dir' : 'exe'}`),
    ms: Date.now() - t,
    adapters: ad.map(a => `${a.name} [${a.desc}] full=${a.fullRoute}`),
    notices: conflicts([], ad).map(n => `${n.level}: ${n.title}`)
  }, null, 1))
  app.quit()
})
