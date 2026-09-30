/**
 * Admin management page (Task 2 Step 4).
 *
 * A deliberately minimal SERVER-RENDERED single-page shell (no bundler, no
 * client framework — this is an intranet operator page, not the desktop
 * client, so DESIGN.md client rules do not apply). The shell embeds NO
 * server-side user data: every table row is rendered client-side from
 * authenticated fetches via textContent (no HTML injection surface). All
 * mutating calls carry the bearer token.
 *
 * P7 (Task 6.5): the page is UNAUTHENTICATED, so it renders the same bytes
 * whether or not a token is configured — an earlier banner said
 * "MARKET_SERVER_ADMIN_TOKEN is not configured", which let an unauthenticated
 * observer tell whether the admin surface was disabled. The `admin-disabled`
 * answer now lives only in the JSON API, where an operator with the token (or
 * the startup log) sees it.
 */

export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>market-server 管理</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}
td,th{border:1px solid #ccc;padding:.3rem .5rem;text-align:left;vertical-align:top}
.hint{color:#666;font-size:.8rem}
button{margin:.15rem;padding:.25rem .6rem;cursor:pointer}
input,textarea{padding:.3rem;margin:.15rem;max-width:100%}
fieldset{border:1px solid #ccc;border-radius:4px;margin-bottom:1rem}
code,pre{background:#f5f5f5;padding:.2rem .4rem;border-radius:3px;font-size:.8rem}
pre{overflow:auto;max-height:16rem}
.mono{font-family:ui-monospace,monospace;font-size:.75rem}
</style>
</head>
<body>
<h1>market-server 管理面</h1>
<fieldset>
  <legend>认证</legend>
  <label>Admin bearer token: <input id="token" type="password" size="40"></label>
  <button id="saveToken">保存 token（仅本浏览器 sessionStorage）</button>
  <span class="hint" id="authState"></span>
</fieldset>

<h2>目录条目</h2>
<table id="entries"><thead><tr>
<th>id</th><th>包</th><th>sha256(前12)</th><th>显示名</th><th>操作</th>
</tr></thead><tbody></tbody></table>

<h2>制品</h2>
<div class="hint">删除端点会先查三个引用面（目录条目 / 已激活清单 / 已 prepare 的待激活清单）：任一面仍引用即 409 拒绝，并在提示里给出解除引用的下一步；三面都无引用才真正删除。被引用的制品不给可点的删除按钮。</div>
<div class="hint" id="artifactMsg"></div>
<h3>可删除</h3>
<table id="artifactsDeletable"><thead><tr>
<th>文件</th><th>字节</th><th>操作</th>
</tr></thead><tbody></tbody></table>
<h3>被引用（不可删除）</h3>
<table id="artifactsReferenced"><thead><tr>
<th>文件</th><th>字节</th><th>操作</th>
</tr></thead><tbody></tbody></table>

<fieldset>
  <legend>发布制品（上传 .tgz）</legend>
  <div><input id="file" type="file" accept=".tgz,application/gzip"> <span class="hint">tarball 的 package.json 须零依赖且无 preinstall/install/postinstall/prepare（发布侧门，违反即拒）</span></div>
  <div><input id="upName" placeholder="displayName（必填）" size="30"> <input id="upSummary" placeholder="summary（必填）" size="50"></div>
  <button id="upload">上传并上架</button> <span id="uploadMsg" class="hint"></span>
</fieldset>

<fieldset>
  <legend>编辑条目</legend>
  <div><input id="editId" placeholder="条目 id" size="40"></div>
  <div><input id="editDisplayName" placeholder="displayName" size="30"> <input id="editSummary" placeholder="summary" size="50"></div>
  <div><input id="editHomepage" placeholder="homepage（留空或 https://…）" size="40"></div>
  <div><input id="editPublisherName" placeholder="publisher name" size="30"> <input id="editPublisherUrl" placeholder="publisher url（https://…）" size="40"></div>
  <div><input id="editRepositoryUrl" placeholder="repository url（https://…）" size="40"></div>
  <div class="hint">URL 类展示字段：留空即可（schema 非必填）；填非 https 值会被拒绝（round3 R15）。</div>
  <button id="applyEdit">应用修改</button> <span id="editMsg" class="hint"></span>
</fieldset>

<h2>两步离线签名发布流</h2>
<fieldset>
  <legend>第 1 步：生成待签清单（pending manifest）</legend>
  <button id="prepare">生成/重新生成待签清单</button>
  <button id="showPending">查看当前待签清单</button> <span id="pendingMsg" class="hint"></span>
  <pre id="pendingView" class="mono"></pre>
</fieldset>
<fieldset>
  <legend>第 3 步：上传离线签名（sign-manifest.mjs 产出的 sidecar JSON）</legend>
  <input id="sigFile" type="file" accept=".json">
  <button id="activate">上传签名并激活</button> <span id="activateMsg" class="hint"></span>
</fieldset>

<h2>状态</h2>
<pre id="stateView" class="mono"></pre>

<script>
const tokenInput = document.getElementById('token')
tokenInput.value = sessionStorage.getItem('marketAdminToken') || ''
function authHeaders() {
  const token = sessionStorage.getItem('marketAdminToken') || tokenInput.value
  return token ? { authorization: 'Bearer ' + token } : {}
}
async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options && options.headers) } })
  const body = await response.json().catch(() => null)
  return { status: response.status, body, headers: response.headers }
}
function setText(id, text) { document.getElementById(id).textContent = text }

function referenceFaceHint(face) {
  if (face === 'catalog') return '被目录条目引用'
  if (face === 'manifest') return '被已激活清单引用'
  if (face === 'pending') return '被已 prepare 的待激活清单引用'
  if (face === 'manifest-unreadable') return '已激活清单无法解析（fail-closed）'
  if (face === 'pending-unreadable') return '待激活清单无法解析（fail-closed）'
  return '仍被引用'
}

document.getElementById('saveToken').onclick = () => {
  sessionStorage.setItem('marketAdminToken', tokenInput.value)
  refresh()
}

async function refresh() {
  const { status, body } = await api('/v1/admin/state')
  if (status !== 200) { setText('authState', '未认证或 admin 面禁用（' + status + '）'); return }
  setText('authState', '已认证')
  const tbody = document.querySelector('#entries tbody')
  tbody.textContent = ''
  for (const entry of body.entries) {
    const row = document.createElement('tr')
    const cells = [entry.id, entry.packageName + '@' + entry.version, (entry.sha256 || '').slice(0, 12), entry.displayName]
    for (const value of cells) {
      const cell = document.createElement('td')
      cell.textContent = value
      row.appendChild(cell)
    }
    const actions = document.createElement('td')
    const unpublish = document.createElement('button')
    unpublish.textContent = '下架'
    unpublish.onclick = async () => {
      const result = await api('/v1/admin/entries/' + encodeURIComponent(entry.id) + '/unpublish', { method: 'POST' })
      setText('editMsg', result.status === 200 ? '已下架 ' + entry.id : JSON.stringify(result.body))
      refresh()
    }
    actions.appendChild(unpublish)
    row.appendChild(actions)
    tbody.appendChild(row)
  }

  const deletableBody = document.querySelector('#artifactsDeletable tbody')
  const referencedBody = document.querySelector('#artifactsReferenced tbody')
  deletableBody.textContent = ''
  referencedBody.textContent = ''
  for (const artifact of body.artifacts) {
    const row = document.createElement('tr')
    for (const value of [artifact.fileName, String(artifact.size)]) {
      const cell = document.createElement('td')
      cell.textContent = value
      row.appendChild(cell)
    }
    const actions = document.createElement('td')
    const remove = document.createElement('button')
    remove.textContent = '删除制品'
    if (artifact.deletable) {
      remove.onclick = async () => {
        const result = await api('/v1/admin/artifact?file=' + encodeURIComponent(artifact.fileName), { method: 'DELETE' })
        setText('artifactMsg', result.status === 204
          ? '已删除 ' + artifact.fileName + '，回收 ' + (result.headers.get('x-artifact-bytes-reclaimed') || '?') + ' 字节'
          : result.status + ' ' + JSON.stringify(result.body))
        refresh()
      }
      actions.appendChild(remove)
      row.appendChild(actions)
      deletableBody.appendChild(row)
    } else {
      // P11b: 被引用的制品不给可点的删除按钮（与 P26 的 IMMUTABLE 灰化同款思路）。
      remove.disabled = true
      actions.appendChild(remove)
      const hint = document.createElement('span')
      hint.className = 'hint'
      hint.textContent = ' ' + referenceFaceHint(artifact.referencedBy)
      actions.appendChild(hint)
      row.appendChild(actions)
      referencedBody.appendChild(row)
    }
  }

  setText('stateView', JSON.stringify({
    entryCount: body.entryCount,
    maxRevision: body.maxRevision,
    active: body.active,
    activeRevision: body.activeRevision,
    pending: body.pending,
    adminEnabled: body.adminEnabled,
  }, null, 2))
}

document.getElementById('upload').onclick = async () => {
  const file = document.getElementById('file').files[0]
  if (!file) { setText('uploadMsg', '请选择 .tgz 文件'); return }
  const params = new URLSearchParams({ displayName: document.getElementById('upName').value, summary: document.getElementById('upSummary').value })
  const result = await api('/v1/admin/artifacts?' + params.toString(), { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: file })
  setText('uploadMsg', result.status === 201 ? '已上架 ' + result.body.entry.id + ' sha256=' + result.body.sha256 : result.status + ' ' + JSON.stringify(result.body))
  refresh()
}

document.getElementById('applyEdit').onclick = async () => {
  const id = document.getElementById('editId').value
  if (!id) { setText('editMsg', '填写条目 id'); return }
  const patch = {}
  const fields = ['editDisplayName:displayName', 'editSummary:summary', 'editHomepage:homepage', 'editPublisherName:publisherName', 'editPublisherUrl:publisherUrl', 'editRepositoryUrl:repositoryUrl']
  for (const mapping of fields) {
    const [elementId, key] = mapping.split(':')
    const value = document.getElementById(elementId).value
    if (value !== '') patch[key] = value
    else if (key === 'homepage' || key === 'publisherUrl' || key === 'repositoryUrl') patch[key] = ''
  }
  const result = await api('/v1/admin/entries/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  setText('editMsg', result.status === 200 ? '已更新' : result.status + ' ' + JSON.stringify(result.body))
  refresh()
}

document.getElementById('prepare').onclick = async () => {
  const result = await api('/v1/admin/manifest/prepare', { method: 'POST' })
  setText('pendingMsg', result.status === 200 ? '待签清单已生成（revision=' + result.body.pendingManifest.envelope.revision + '）' : JSON.stringify(result.body))
  document.getElementById('pendingView').textContent = result.status === 200 ? JSON.stringify(result.body.pendingManifest, null, 2) : ''
  refresh()
}

document.getElementById('showPending').onclick = async () => {
  const result = await api('/v1/admin/manifest/pending')
  setText('pendingMsg', result.status === 200 ? '' : JSON.stringify(result.body))
  document.getElementById('pendingView').textContent = result.status === 200 ? JSON.stringify(result.body.pendingManifest, null, 2) : ''
}

document.getElementById('activate').onclick = async () => {
  const file = document.getElementById('sigFile').files[0]
  if (!file) { setText('activateMsg', '请选择签名 JSON 文件'); return }
  const text = await file.text()
  const result = await api('/v1/admin/manifest/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
  setText('activateMsg', result.status === 200 ? '已激活 revision=' + result.body.revision : result.status + ' ' + JSON.stringify(result.body))
  refresh()
}

refresh()
</script>
</body>
</html>
`
}
