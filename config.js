// 公開してよい値だけを書く。秘密の値（チャネルシークレットやアクセストークン）は書かない。
// liffId と apiUrl が空のとき、または URL に ?demo=1 があるときはデモ表示になり、どこにも送信しない。
window.TODA_SNS_CONFIG = {
  // LINE Developers の LIFF ID（例：2000000000-AbCdEfGh）
  liffId: '',
  // Google Apps Script のウェブアプリURL
  apiUrl: 'https://script.google.com/macros/s/AKfycbwx1jLyepgjj2S91vqHGPJAyI7zjShezwEqyoIKV54wuo4_HVon59Nl_ToeKPHRW6Dn/exec',
  // グループへのお知らせに載せるURL（https://liff.line.me/LIFF ID）
  liffUrl: '',
  // お知らせを送る公式アカウントの友だち追加URL（https://line.me/R/ti/p/@xxxx）
  oaFriendUrl: '',
  // 完了画面で案内する公式アカウントの呼び名
  oaName: 'ミアキスの公式アカウント（試作中）',
  // 画面の上に出す帯。本番で空にする
  notice: '試作版です（ミアキスの公式アカウントで試しています）',
  // 「今月◯件届いています」を出す最小件数。少ないときは出さない
  socialProofMin: 3,
};
