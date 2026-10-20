// 插件浏览器侧的端到端检查：真 client.js + jsdom + 真实 React，只在 Tavern 的 HTTP 路由上打桩。
// 跑法：node --test plugins/dsh-tavern-worldbook-panel/tests/panel.test.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const ENTRY_CONSTANT = { ref: 'entry:0', title: '王城设定', comment: '王城设定', content: '王城位于大陆中央。', enabled: true, constant: true, selective: false, position: 1, depth: 4, primaryKeys: [], secondaryKeys: [], order: 100 }
const ENTRY_KEYWORD = { ref: 'entry:1', title: '雨季', comment: '雨季', content: '每年七月进入雨季。', enabled: true, constant: false, selective: true, position: 0, depth: 3, primaryKeys: ['雨'], secondaryKeys: [], order: 90 }

// 与宿主真实返回结构一致：catalog 给 standalone/embedded 行，get 给 { source, view, globalEnabled }。
function catalogOf(entries) {
	return {
		listWorldBooks: () => ({
			standalone: [{ kind: 'standalone', path: 'worldbooks/a.json', name: '王城世界', globalEnabled: false, entryCount: entries.length, enabledCount: entries.length, diagnostics: 0, importedAt: 0, updatedAt: 0 }],
			embedded: [],
			diagnostics: [],
		}),
		getWorldBook: () => ({
			source: { kind: 'standalone', path: 'worldbooks/a.json' },
			globalEnabled: false,
			view: { displayName: '王城世界', entryCount: entries.length, enabledCount: entries.length, scanDepth: 2, entries },
		}),
	}
}

async function boot(handlers) {
	const dom = new JSDOM('<!doctype html><html><body><div id="anchor" style="position:fixed;top:10px;left:400px;width:28px;height:28px"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
	const calls = []
	const fetch = async (url, options) => {
		const method = String(url).replace('/api/dsh-tavern/', '')
		const body = options && options.body ? JSON.parse(options.body) : {}
		calls.push([method, body])
		const handler = handlers[method]
		const payload = handler ? await handler(body, calls) : {}
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
	}

	globalThis.window = dom.window
	globalThis.document = dom.window.document
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
	globalThis.HTMLElement = dom.window.HTMLElement
	globalThis.Element = dom.window.Element
	globalThis.Node = dom.window.Node
	globalThis.CustomEvent = dom.window.CustomEvent
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	const realFetch = globalThis.fetch
	globalThis.fetch = fetch

	const React = (await import('react')).default
	const ReactDOMClient = await import('react-dom/client')
	const ReactDOM = await import('react-dom')
	const provided = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient }

	let plugin = null
	dom.window.__ModuleLoader__ = {
		load(definition) {
			plugin = definition.factory((name) => {
				if (!(name in provided)) throw new Error('测试没有提供模块：' + name)
				return provided[name]
			})
		},
	}
	// 插件是按普通脚本执行的，不是在模块作用域里，这里还原那个环境。
	new Function('window', 'document', 'fetch', 'console', source)(dom.window, dom.window.document, fetch, console)

	const registered = []
	const panels = []
	const slots = {
		// 真实 slots.inject 的语义是「槽位可用时调用这个工厂」；测试里立即调用。
		inject(name, factory) { return factory() },
		register(definition, component) {
			registered.push({ definition, component })
			return () => {}
		},
	}
	const tavernUi = {
		apiVersion: 2,
		registerPanel(input) { panels.push(input); return () => {} },
	}
	const ctx = {
		cleanups: [],
		openedTab: null,
		get(name) {
			if (name === 'slots') return slots
			if (name === 'tavernUi') return tavernUi
			if (name === 'betterSidebar') return { openTab: (seed, scope) => { ctx.openedTab = { seed, scope } } }
			return undefined
		},
		effect(factory) {
			const dispose = factory()
			const cleanup = typeof dispose === 'function' ? dispose : () => {}
			ctx.cleanups.push(cleanup)
			return cleanup
		},
	}
	plugin.apply(ctx)
	const triggerEntry = registered.find(entry => entry.definition && String(entry.definition.id || '').endsWith(':trigger'))
	return { dom, calls, React, ctx, plugin, triggerEntry, panels, restore: () => { globalThis.fetch = realFetch } }
}

function tick() { return new Promise(resolve => setTimeout(resolve, 0)) }

/** 打开面板并等到列表里出现条目行（异步链路：catalog → 选中书 → 拉条目）。 */
async function openPanel(React, triggerEntry, dom, sessionId) {
	const { act } = React
	const ReactDOMClient = await import('react-dom/client')
	const host = dom.window.document.createElement('div')
	dom.window.document.body.append(host)
	const root = ReactDOMClient.createRoot(host)
	await act(async () => { root.render(React.createElement(triggerEntry.component, { sessionId })) })
	const button = host.querySelector('.dsh-wbp-trigger')
	assert.ok(button, '有 sessionId 时应渲染图标按钮')
	await act(async () => { button.click() })
	const document = dom.window.document
	for (let attempt = 0; attempt < 40; attempt++) {
		await act(async () => { await tick() })
		if (document.querySelector('.dsh-wbp-switch input')) break
	}
	return { document, host, root, button }
}

test('插件：顶栏按钮打开面板，列出条目并即时写回开关', async () => {
	const { dom, calls, React, triggerEntry, restore } = await boot({
		...catalogOf([ENTRY_CONSTANT, ENTRY_KEYWORD]),
		updateWorldBook: body => ({ worldBook: { entries: [] }, operation: body.update.operations[0] }),
	})
	try {
		assert.ok(triggerEntry, '顶栏按钮应注册到 conversation.session.header.utilities')
		assert.equal(triggerEntry.definition.order, 79)
		const { document } = await openPanel(React, triggerEntry, dom, 'session-1')
		assert.ok(document.querySelector('.dsh-wbp-shell'), '点按钮应弹出面板')
		assert.ok(calls.some(call => call[0] === 'listWorldBooks'), '面板应读取世界书目录')
		assert.ok(calls.some(call => call[0] === 'getWorldBook'), '选中书后应读取条目')

		const rows = document.querySelectorAll('.dsh-wbp-row')
		assert.ok(rows.length >= 2, '应列出两条条目，实际 ' + rows.length)
		const toggle = document.querySelector('.dsh-wbp-switch input')
		await React.act(async () => { toggle.click() })
		for (let attempt = 0; attempt < 20 && !calls.some(call => call[0] === 'updateWorldBook'); attempt++) {
			await React.act(async () => { await tick() })
		}
		const update = calls.filter(call => call[0] === 'updateWorldBook').pop()
		assert.ok(update, '开关应写回 updateWorldBook，实际调用：' + calls.map(call => call[0]).join(','))
		assert.equal(update[1].update.operations[0].op, 'update')
		assert.equal(typeof update[1].update.operations[0].patch.enabled, 'boolean')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：完整版的主面板元素与「完整」跳转都在', async () => {
	const { dom, React, triggerEntry, ctx, restore } = await boot(catalogOf([ENTRY_CONSTANT]))
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-2')
		const shell = document.querySelector('.dsh-wbp-shell')
		assert.ok(shell, '面板应挂载')
		assert.ok(document.querySelector('.dsh-wbp-select'), '应有选书下拉')
		assert.ok(document.querySelector('.dsh-wbp-search'), '应有条目搜索框')
		assert.ok(Array.from(document.querySelectorAll('.dsh-wbp-icon')).some(node => node.getAttribute('aria-label') === '设置'), '应有设置入口')
		const full = Array.from(shell.querySelectorAll('.dsh-wbp-btn')).find(node => node.textContent === '完整')
		assert.ok(full, '应有「完整」按钮')
		await React.act(async () => { full.click() })
		assert.equal(ctx.openedTab && ctx.openedTab.seed.type, 'dsh-tavern:worldbooks', '「完整」应打开右侧栏书库')
		assert.equal(ctx.openedTab.scope.sessionId, 'session-2')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：没有会话时不渲染按钮，卸载时清理干净', async () => {
	const { dom, React, triggerEntry, ctx, restore } = await boot(catalogOf([ENTRY_CONSTANT]))
	try {
		const { act } = React
		const ReactDOMClient = await import('react-dom/client')
		const host = dom.window.document.createElement('div')
		dom.window.document.body.append(host)
		const root = ReactDOMClient.createRoot(host)
		await act(async () => { root.render(React.createElement(triggerEntry.component, {})) })
		assert.equal(host.querySelector('.dsh-wbp-trigger'), null, '没有 sessionId 时不渲染')

		const containers = dom.window.document.querySelectorAll('.dsh-wbp-portal')
		assert.equal(containers.length, 1, '面板容器应挂在 body')
		for (const cleanup of ctx.cleanups) cleanup()
		assert.equal(dom.window.document.querySelectorAll('.dsh-wbp-portal').length, 0, '卸载后容器应移除')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：接管核心按钮的两条路径（顶栏直点、折叠进 ⋮ 菜单）', async () => {
	const { dom, React, triggerEntry, restore } = await boot(catalogOf([ENTRY_CONSTANT]))
	try {
		const document = dom.window.document
		const { act } = React
		const ReactDOMClient = await import('react-dom/client')
		// 先渲染一次，让插件记下当前会话号。
		const host = document.createElement('div')
		document.body.append(host)
		const root = ReactDOMClient.createRoot(host)
		await act(async () => { root.render(React.createElement(triggerEntry.component, { sessionId: 'session-9' })) })

		// 路径一：顶栏上直接可见的按钮（外层 span 带 data-header-item）。
		const headerItem = document.createElement('span')
		headerItem.dataset.headerItem = 'dsh-tavern:worldbooks'
		const directButton = document.createElement('button')
		directButton.textContent = '世界书'
		headerItem.append(directButton)
		document.body.append(headerItem)
		await act(async () => { directButton.click() })
		await act(async () => { await tick() })
		assert.ok(document.querySelector('.dsh-wbp-shell'), '点顶栏世界书按钮应弹出插件面板')

		// 关掉。
		await act(async () => { windowEvent(dom, 'keydown', { key: 'Escape' }) })
		await act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-shell'), null, 'Esc 应关闭面板')

		// 路径二：折叠进 ⋮ 菜单后，菜单项没有 data-header-item，只能按文本认。
		const more = document.createElement('button')
		more.dataset.tavernHeaderTrigger = 'more'
		document.body.append(more)
		const menu = document.createElement('div')
		menu.className = 'dsh-tavern-more-menu'
		const worldbookItem = document.createElement('button')
		worldbookItem.setAttribute('role', 'menuitem')
		worldbookItem.textContent = '世界书'
		const otherItem = document.createElement('button')
		otherItem.setAttribute('role', 'menuitem')
		otherItem.textContent = '人物卡'
		menu.append(worldbookItem, otherItem)
		document.body.append(menu)

		await act(async () => { otherItem.click() })
		await act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-shell'), null, '点别的菜单项不应开世界书面板')

		await act(async () => { worldbookItem.click() })
		await act(async () => { await tick() })
		assert.ok(document.querySelector('.dsh-wbp-shell'), '点 ⋮ 里的世界书应弹出插件面板')
	} finally {
		restore()
		dom.window.close()
	}
})

function windowEvent(dom, type, init) {
	dom.window.document.dispatchEvent(new dom.window.KeyboardEvent(type, Object.assign({ bubbles: true }, init)))
}

test('插件：注册侧栏页，页内是嵌入形态的完整面板（「插件」分区可见的前提）', async () => {
	const { dom, React, panels, restore } = await boot(catalogOf([ENTRY_CONSTANT, ENTRY_KEYWORD]))
	try {
		assert.equal(panels.length, 1, '应注册且只注册一个侧栏页')
		const [panel] = panels
		// Tavern 只把 tavern-plugin:<owner>:<id> 归进侧栏「插件」分组；id 必须是短 slug。
		assert.equal(panel.id, 'worldbooks')
		assert.equal(panel.title, '加强版世界书', '侧栏卡片与页标题都用插件名')
		assert.match(panel.id, /^[a-z0-9][a-z0-9._-]{0,63}$/, 'registerPanel 的 id 只能是小写 slug')
		assert.equal(typeof panel.render, 'function')

		const { act } = React
		const ReactDOMClient = await import('react-dom/client')
		const host = dom.window.document.createElement('div')
		dom.window.document.body.append(host)
		const root = ReactDOMClient.createRoot(host)
		await act(async () => { root.render(React.createElement(panel.render, { gameId: 'session-7', visible: true })) })
		for (let attempt = 0; attempt < 40; attempt++) {
			await act(async () => { await tick() })
			if (dom.window.document.querySelector('.dsh-wbp-tab')) break
		}

		const shell = dom.window.document.querySelector('.dsh-wbp-shell')
		assert.ok(shell, '侧栏页里应渲染面板')
		assert.ok(shell.classList.contains('is-embed'), '侧栏页里必须是嵌入形态，不能是浮层')
		assert.equal(shell.getAttribute('role'), 'region', '嵌入形态不是对话框')
		// 浮层的定位靠 inline style；嵌入形态必须一无所有，否则会飘出侧栏。
		assert.equal(shell.style.position, '', '嵌入形态不应写 inline 定位')
		assert.equal(shell.style.left, '')
		assert.equal(shell.style.width, '')
		// 走手机那套单列 + 标签页，侧栏宽度放得下。
		assert.ok(shell.classList.contains('is-mobile'))
		const tabs = Array.from(dom.window.document.querySelectorAll('.dsh-wbp-tab')).map(node => node.textContent.trim())
		assert.deepEqual(tabs, ['世界书', '条目', '常用', '完整'], '应有四个标签')
		// 侧栏页默认停在「世界书」（换书），而不是空着的「条目」页。
		const active = dom.window.document.querySelector('.dsh-wbp-tab.is-active')
		assert.equal(active && active.textContent.trim(), '世界书', '默认停在世界书页')

		// 切到「条目」页，开关列表就在这里。
		const entriesTab = Array.from(dom.window.document.querySelectorAll('.dsh-wbp-tab')).find(node => node.textContent.trim() === '条目')
		await act(async () => { entriesTab.click() })
		for (let attempt = 0; attempt < 20; attempt++) {
			await act(async () => { await tick() })
			if (dom.window.document.querySelector('.dsh-wbp-row')) break
		}
		const rows = dom.window.document.querySelectorAll('.dsh-wbp-row')
		assert.ok(rows.length >= 2, '条目页应列出条目，实际 ' + rows.length)
	} finally {
		restore()
		dom.window.close()
	}
})
