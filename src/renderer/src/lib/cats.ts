export type Cat = 'all' | 'browser' | 'chat' | 'ai' | 'games' | 'dev' | 'media' | 'other'

const RULES: [Cat, RegExp][] = [
  ['browser', /chrome|firefox|msedge|edge|opera|brave|yandex(?!.*music)|vivaldi|browser|tor\b|arc\.exe|librewolf|waterfox|thorium/i],
  ['chat', /discord|telegram|whatsapp|slack|teams|zoom|skype|viber|signal|element|vk ?messenger|mattermost|teamspeak|mumble/i],
  ['ai', /claude|chatgpt|openai|codex|copilot|perplexity|gemini|ollama|lm ?studio|cursor|windsurf/i],
  ['games', /steam|epic|battle\.?net|riot|valorant|league|ubisoft|uplay|origin|ea app|gog|game|lineage|l2|minecraft|roblox|launcher|wargaming|lesta|4game|faceit|genshin|hoyo/i],
  ['dev', /code|idea|jetbrains|pycharm|webstorm|rider|clion|goland|datagrip|android studio|visual studio|git|node|docker|postman|insomnia|wsl|terminal|putty|winscp|navicat|dbeaver|heidisql|fiddler|wireshark/i],
  ['media', /spotify|vlc|obs|music|potplayer|mpc|aimp|foobar|twitch|youtube|netflix|kinopoisk|audacity|premiere|davinci|photoshop|figma/i]
]

export function catOf(name: string, exe: string): Exclude<Cat, 'all'> {
  const s = name + ' ' + exe.split('\\').pop()
  for (const [c, re] of RULES) if (re.test(s)) return c as Exclude<Cat, 'all'>
  return 'other'
}

export const CATS: Cat[] = ['all', 'browser', 'chat', 'ai', 'games', 'dev', 'media', 'other']
