(() => {
		const cfg = window.BOORUHUB_CONFIG || { user: 'ExperiencesXP', pages: 2 };
		// Allow token from localStorage to increase API rate limit (optional, else it'll use a limited unathenticated version)
		try { cfg.token = cfg.token || localStorage.getItem('gitbooru.token') || undefined; } catch {}

	// Apply saved theme early
	try {
		const theme = localStorage.getItem('gitbooru.theme') || '';
		const accent = localStorage.getItem('gitbooru.accent') || localStorage.getItem('gitbooru.ctpAccent') || '';
		if (theme) document.documentElement.setAttribute('data-theme', theme);
		if (accent) {
			document.documentElement.style.setProperty('--brand', accent);
			if (theme.startsWith('ctp-')) {
				document.documentElement.style.setProperty('--ctp-accent', accent);
			}
		}
	} catch {}
	const elGrid = document.getElementById('grid');
	const elLang = document.getElementById('language-select');
	const elResult = document.getElementById('result-count');
	const elTotal = document.getElementById('total-count');
	const elStatus = document.getElementById('status');
	const elPager = document.getElementById('pager');
	const isHome = document.body.classList.contains('home');
	const elVisitors = document.getElementById('visitors-count');
	// splash elements
	const splashForm = document.getElementById('splash-search-form');
	const splashQuery = document.getElementById('splash-query');
	const elServing = document.getElementById('serving-count');
	const elMoeRepos = document.getElementById('moe-repos');
	// sidebar elements
	const elTagsList = document.getElementById('tags-list');
	const elLangsList = document.getElementById('langs-list');
	const form = document.getElementById('search-form');
	const nameInput = document.getElementById('name-input');
	const tagsInput = document.getElementById('tags-input');
	const sortSelect = document.getElementById('sort-select');
	const sortDirBtn = document.getElementById('sort-dir');

	let allRepos = [];
	let current = [];
	let sortDir = 'desc';

		const headers = (() => {
			const h = { 'Accept': 'application/vnd.github+json' };
			if (cfg.token) h['Authorization'] = `Bearer ${cfg.token}`;
			return h;
		})();

	function setStatus(msg, kind = 'info') {
		elStatus.textContent = msg || '';
		elStatus.className = kind;
	}

	function loadCache(freshOnly = true) {
		try {
			const raw = localStorage.getItem(CACHE_KEY);
			if (!raw) return null;
			const data = JSON.parse(raw);
			if (freshOnly && (Date.now() - data.time > CACHE_TTL)) return null;
			return data.payload;
		} catch { return null; }
	}
	function saveCache(payload) {
		try { localStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), payload })); } catch {}
	}

	async function fetchAllRepos(user, pages = 2) {
		const cached = loadCache(true);
		if (cached && Array.isArray(cached) && cached.length) {
			// Ensure fork tags and numeric fields exist even for cached payloads
			cached.forEach(r => {
				if (!r) return;
				if (r.fork) {
					const base = new Set((r.topics || []).map(t => String(t).toLowerCase()));
					['fork', 'forked'].forEach(t => { if (!base.has(t)) (r.topics || (r.topics=[])).push(t); });
				}
				if (typeof r.watchers !== 'number') r.watchers = 0;
				if (typeof r.issues !== 'number') r.issues = 0;
			});
			return cached;
		}
		const results = [];
		for (let page = 1; page <= pages; page++) {
			const url = `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&page=${page}&sort=updated`;
			const res = await fetch(url, { headers });
			if (res.status === 403) throw new Error('GitHub API rate limit reached. Try again later.');
			if (!res.ok) throw new Error(`Failed to load repos: ${res.status}`);
			const data = await res.json();
			if (!Array.isArray(data) || data.length === 0) break;
			results.push(...data);
			if (data.length < 100) break; // last page
		}
		// normalize
		const normalized = results.map(r => ({
			id: r.id,
			name: r.name,
			full_name: r.full_name,
			html_url: r.html_url,
			description: r.description || '',
			stars: r.stargazers_count || 0,
			forks: r.forks_count || 0,
			watchers: (typeof r.subscribers_count === 'number' ? r.subscribers_count : (typeof r.watchers_count === 'number' ? r.watchers_count : 0)),
			issues: r.open_issues_count || 0,
			language: r.language || '',
			topics: Array.isArray(r.topics) ? r.topics : [],
			fork: !!r.fork,
			updated_at: r.updated_at,
			created_at: r.created_at,
			avatar: r.owner && r.owner.avatar_url ? r.owner.avatar_url : '',
			homepage: r.homepage || '',
			archived: !!r.archived,
		}));
		normalized.forEach(r => {
			if (r.fork) {
				const base = new Set((r.topics || []).map(t => String(t).toLowerCase()));
				['fork', 'forked'].forEach(t => { if (!base.has(t)) (r.topics || (r.topics=[])).push(t); });
			}
		});
		saveCache(normalized);
		return normalized;
	}

	// Fetch topics per repo with limited concurrency
	async function enrichTopics(repos) {
		// Fetch by the 50 most recent
		const limited = [...repos].sort((a,b)=> new Date(b.updated_at)-new Date(a.updated_at)).slice(0,50);
		const toFetch = limited.filter(r => !r.topics || r.topics.length === 0);
		if (!toFetch.length) return repos;
		const limit = 3;
		let idx = 0;
		const run = async () => {
			while (idx < toFetch.length) {
				const cur = toFetch[idx++];
				try {
						const res = await fetch(`https://api.github.com/repos/${cur.full_name}/topics`, { headers: { ...headers, 'Accept': 'application/vnd.github+json, application/vnd.github.mercy-preview+json' } });
					if (res.ok) {
						const data = await res.json();
							if (data && Array.isArray(data.names)) {
								const merged = new Set([...(cur.topics || []).map(t=>String(t).toLowerCase()), ...data.names.map(t=>String(t).toLowerCase())]);
								cur.topics = Array.from(merged);
							}
					} else if (res.status === 403) {
						// stop fetching further to avoid hammering when rate limited
						setStatus('Hit GitHub API limit while fetching topics. Tags may be incomplete.', 'warn');
						break;
					}
				} catch {}
			}
		};
		const workers = Array.from({ length: limit }, run);
		await Promise.all(workers);
		return repos;
	}

	async function enrichWatchers(repos) {
		if (!Array.isArray(repos) || !repos.length) return repos;
		const top = [...repos].sort((a,b)=> (b.stars||0) - (a.stars||0)).slice(0,30);
		const limit = 3;
		let idx = 0;
		const run = async () => {
			while (idx < top.length) {
				const cur = top[idx++];
				try {
					const res = await fetch(`https://api.github.com/repos/${cur.full_name}`, { headers });
					if (res.ok) {
						const data = await res.json();
						if (data && typeof data.subscribers_count === 'number') {
							cur.watchers = data.subscribers_count;
						}
					} else if (res.status === 403) {
						setStatus('Hit GitHub API limit while fetching watchers. Counts may be approximate.', 'warn');
						break;
					}
				} catch {}
			}
		};
		const workers = Array.from({ length: limit }, run);
		await Promise.all(workers);
		return repos;
	}

	function buildLanguages(repos) {
			// Build a case-insensitive unique list of languages, preserving first-seen casing
			const map = new Map(); // lower -> original
			for (const r of repos) {
				const lang = r && r.language ? String(r.language).trim() : '';
				if (!lang) continue;
				const key = lang.toLowerCase();
				if (!map.has(key)) map.set(key, lang);
			}
			const list = Array.from(map.values()).sort((a,b) => a.localeCompare(b));

			if (elLang) {
				elLang.innerHTML = '<option value="">Any</option>' + list.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
			}

			// Ensure all languages are available as <meta name="language" content="..."> tags in the document head
			try { injectLanguageMetaTags(list); } catch {}
	}

	function injectLanguageMetaTags(langs) {
		const head = document.head || document.getElementsByTagName('head')[0];
		if (!head) return;
		// Remove previously injected language meta tags
		const old = head.querySelectorAll('meta[name="language"]');
		old.forEach(m => m.parentNode && m.parentNode.removeChild(m));
		// Add one meta tag per language
		for (const l of langs) {
			const meta = document.createElement('meta');
			meta.setAttribute('name', 'language');
			meta.setAttribute('content', l);
			head.appendChild(meta);
		}
	}

	function escapeHtml(str) {
		return String(str).replace(/[&<>"]+/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
	}

	// Normalize tag aliases so searches treat them the same
	function normalizeTag(tag) {
		const t = String(tag).toLowerCase();
		const map = {
			forked: 'fork'
		};
		return map[t] || t;
	}

	// Prepare displayed tags for repo cards (UI only)
	function displayedTopics(repo) {
		const base = new Set((repo.topics || []).map(normalizeTag));
		// If it's a fork or tagged as fork, don't show fork/forked as topic chips (handled as meta badge instead)
		if (repo.fork || base.has('fork')) {
			base.delete('fork');
			base.delete('forked');
		}
		return Array.from(base);
	}

	// Parse tags-style query for special tokens similar to booru search
	// Supports: sort:<stars|forks|updated|created> dir:<asc|desc> lang:<Name> name:"quoted words" name:<word> -tag
	function parseTagsQuery(raw) {
		const ctx = { include: [], exclude: [], sortKey: null, dir: null, lang: null, nameQ: '' };
		if (!raw) return ctx;
		const quoted = raw.match(/(?:^|\s)name:\"([^\"]+)\"/i);
		if (quoted) ctx.nameQ = quoted[1];
		const cleaned = raw.replace(/(?:^|\s)name:\"[^\"]+\"/ig, ' ').trim();
		const parts = cleaned.split(/\s+/).filter(Boolean);
		for (const p of parts) {
			const low = p.toLowerCase();
			if (low.startsWith('sort:')) { ctx.sortKey = low.slice(5); continue; }
			if (low.startsWith('dir:') || low.startsWith('order:')) { ctx.dir = low.split(':')[1]; continue; }
			if (low.startsWith('lang:') || low.startsWith('language:')) { ctx.lang = p.split(':')[1]; continue; }
			if (low.startsWith('name:')) { ctx.nameQ = p.slice(5); continue; }
			if (low.startsWith('-') && low.length > 1) { ctx.exclude.push(low.slice(1)); continue; }
			ctx.include.push(low);
		}
		return ctx;
	}

	function applyFilters(repos) {
			const tagsRaw = (tagsInput ? tagsInput.value : '').trim();
			const q = parseTagsQuery(tagsRaw);
			if (q.sortKey && sortSelect) {
				const mapKey = (q.sortKey === 'watching') ? 'watchers' : q.sortKey;
				const allowed = ['stars','forks','watchers','issues','updated','created'];
				sortSelect.value = allowed.includes(mapKey) ? mapKey : (sortSelect.value || 'updated');
			}
			if (q.dir && (q.dir === 'asc' || q.dir === 'desc')) { sortDir = q.dir; if (sortDirBtn) sortDirBtn.textContent = sortDir === 'asc' ? '↓' : '↑'; }
			// If a language was provided via query, select it case-insensitively in the dropdown
			if (q.lang && elLang) {
				const target = String(q.lang).toLowerCase();
				let matched = '';
				for (const opt of Array.from(elLang.options || [])) {
					if (String(opt.value).toLowerCase() === target) { matched = opt.value; break; }
				}
				elLang.value = matched || q.lang;
			}
			if (q.nameQ && nameInput) nameInput.value = q.nameQ;

			const nameQ = (nameInput ? nameInput.value : q.nameQ).trim().toLowerCase();
			// Prefer explicit query language (case-insensitive), fallback to dropdown selection
			const lang = (q.lang || (elLang ? elLang.value : '') || '').trim();
			const includeTags = q.include.map(normalizeTag);
			const excludeTags = q.exclude.map(normalizeTag);

		return repos.filter(r => {
			if (nameQ) {
				const hay = `${r.name} ${r.description}`.toLowerCase();
				if (!hay.includes(nameQ)) return false;
			}
			// Case-insensitive language match
			if (lang && String(r.language || '').toLowerCase() !== String(lang).toLowerCase()) return false;
			const tset = new Set((r.topics || []).map(t => normalizeTag(t)));
			if (includeTags.length) {
				for (const t of includeTags) { if (!tset.has(t)) return false; }
			}
			if (excludeTags.length) {
				for (const t of excludeTags) { if (tset.has(t)) return false; }
			}
			return true;
		});
	}

	function sortRepos(repos) {
			const tagsRaw = (tagsInput ? tagsInput.value : '').trim();
			const q = parseTagsQuery(tagsRaw);
			let key = q.sortKey || (sortSelect ? sortSelect.value : 'updated');
			if (key === 'watching') key = 'watchers';
			const dir = q.dir || sortDir;
		const mul = dir === 'asc' ? 1 : -1;
		const cmpNum = (a,b) => (a - b) * mul;
		const cmpDate = (a,b) => (new Date(a).getTime() - new Date(b).getTime()) * mul;
		const cmpStr = (a,b) => a.localeCompare(b) * mul;
		const sorted = [...repos];
		sorted.sort((a,b) => {
			if (key === 'stars') return cmpNum(a.stars, b.stars) || cmpStr(a.name, b.name);
			if (key === 'forks') return cmpNum(a.forks, b.forks) || cmpStr(a.name, b.name);
			if (key === 'watchers') return cmpNum(a.watchers, b.watchers) || cmpStr(a.name, b.name);
			if (key === 'issues') return cmpNum(a.issues, b.issues) || cmpStr(a.name, b.name);
			if (key === 'updated') return cmpDate(a.updated_at, b.updated_at) || cmpStr(a.name, b.name);
			if (key === 'created') return cmpDate(a.created_at, b.created_at) || cmpStr(a.name, b.name);
			return cmpStr(a.name, b.name);
		});
		return sorted;
	}

	function renderGrid(repos) {
		elGrid.innerHTML = repos.map(r => renderCard(r)).join('');
	}

	function renderCard(r) {
		const desc = r.description ? escapeHtml(r.description) : '';
			const domain = '';
				const topicsForDisplay = displayedTopics(r);
				const topicSet = new Set((r.topics || []).map(normalizeTag));
				const isFork = !!r.fork || topicSet.has('fork');
	    		const tagsHtml = topicsForDisplay.slice(0, 6).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
			const thumb = `https://opengraph.githubassets.com/1/${r.full_name}`;
			return `
				<a class="card" href="${r.html_url}" target="_blank" rel="noopener noreferrer">
					<div class="thumb" style="background-image:url('${thumb}')"></div>
					<div class="content">
						<div class="title">${escapeHtml(r.name)}</div>
						<div class="desc" title="${desc}">${desc}</div>
						<div class="meta">
							<span class="badge" title="Stars">★ ${typeof r.stars === 'number' ? r.stars : 0}</span>
							<span class="badge" title="Forks">⑂ ${typeof r.forks === 'number' ? r.forks : 0}</span>
							<span class="badge" title="Watchers">👁 ${typeof r.watchers === 'number' ? r.watchers : 0}</span>
								${isFork ? `<span class="badge" title="Forked">Forked</span>` : ''}
							${r.language ? `<span class="badge" title="Language">${escapeHtml(r.language)}</span>` : ''}
							${domain ? `<span class="badge" title="Homepage">${escapeHtml(domain)}</span>` : ''}
							${r.issues ? `<span class=\"badge\" title=\"Open issues\">Issues ${r.issues}</span>` : ''}
						</div>
						<div class="tags">${tagsHtml}</div>
					</div>
				</a>
			`;
	}

		function updateCounts(filtered, total) {
		if (elResult) elResult.textContent = String(filtered);
		if (elTotal) elTotal.textContent = String(total);
	}

	// Moe counter showing total repos using getloli's num parameter
	function updateMoeRepos(total, mask = false) {
		if (!elMoeRepos) return;
		const base = 'https://count.getloli.com/@gitbooru-repos-experiencesxp?theme=moebooru&pixelated=0&darkmode=0&scale=2';
		const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
		const src = `${base}&num=${n}`; // avoid cache busters that may trigger extra service behavior
		elMoeRepos.src = src;
		elMoeRepos.title = `${n} repos`;
		elMoeRepos.alt = `${n} repos`;
		const frame = elMoeRepos.closest('.digits-row');
		if (frame) {
			if (mask) frame.classList.add('error-mask');
			else frame.classList.remove('error-mask');
		}
	}

	function runSearch() {
		const filtered = applyFilters(allRepos);
		current = sortRepos(filtered);
		renderGrid(current);
		updateCounts(current.length, allRepos.length);
		elGrid.setAttribute('aria-busy', 'false');
		setStatus(current.length ? '' : 'No repos matched your filters.', 'info');
	}

	function bindEvents() {
			if (form) {
				form.addEventListener('submit', (e) => {
					e.preventDefault();
					if (isHome && splashForm) {
						const q = splashQuery ? splashQuery.value : '';
						const url = 'list.html' + (q ? `?tags=${encodeURIComponent(q)}` : '');
						window.location.href = url;
						return;
					}
					runSearch();
				});
				form.addEventListener('reset', () => {
					setTimeout(() => { if (sortSelect) sortSelect.value = 'updated'; sortDir = 'desc'; if (sortDirBtn) sortDirBtn.textContent = '↑'; runSearch(); }, 0);
				});
			}
			if (splashForm && isHome) {
				splashForm.addEventListener('submit', (e) => {
					e.preventDefault();
					const q = splashQuery ? splashQuery.value : '';
					const url = 'list.html' + (q ? `?tags=${encodeURIComponent(q)}` : '');
					window.location.href = url;
				});
			}
			if (sortSelect) sortSelect.addEventListener('change', runSearch);
			if (sortDirBtn) sortDirBtn.addEventListener('click', () => {
				sortDir = sortDir === 'asc' ? 'desc' : 'asc';
				sortDirBtn.textContent = sortDir === 'asc' ? '↓' : '↑';
				runSearch();
			});
	}

	function updateVisitors() {
			if (!elVisitors) return;
			const setNumber = (n) => { try { elVisitors.textContent = Number(n || 0).toLocaleString(); } catch { elVisitors.textContent = String(n || 0); } };
			const cfgVisitors = (window.BOORUHUB_CONFIG && window.BOORUHUB_CONFIG.visitors) || {};
			// Only use hardcoded config; ignore any localStorage overrides
			const provider = (cfgVisitors.provider || '').toLowerCase();
			const url = cfgVisitors.url || '';

			// Try Cloudflare Worker (expects { total | unique | value } numeric)
			if (provider === 'cloudflare' && url) {
				// Include credentials so the Worker can set/read a cross-site cookie
				fetch(url, { method: 'GET', mode: 'cors', credentials: 'include' })
					.then(r => r.ok ? r.json() : Promise.reject(new Error('CF ' + r.status)))
					.then(d => setNumber(d.total ?? d.unique ?? d.value ?? 0))
					.catch(() => fallbackCountApi(setNumber));
				return;
			}

			// Try public shared analytics JSON (expects { results: { visitors: { value } } })
			if (provider === 'plausible' && url) {
				fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' })
					.then(r => r.ok ? r.json() : Promise.reject(new Error('Plausible ' + r.status)))
					.then(d => {
						const val = (d && d.results && d.results.visitors && typeof d.results.visitors.value === 'number') ? d.results.visitors.value : (d.visitors ?? d.value ?? 0);
						setNumber(val);
					})
					.catch(() => fallbackCountApi(setNumber));
				return;
			}

			// Default fallback: CountAPI with unique-per-browser gate
			fallbackCountApi(setNumber);
	}

	function fallbackCountApi(setNumber) {
			const NS = 'experiencesxp.github.io';
			const KEY = 'global_unique_visitors';
			const STORAGE_FLAG = 'visitor-counted-v1';
			const base = 'https://api.countapi.xyz';
			const counted = (() => { try { return !!localStorage.getItem(STORAGE_FLAG); } catch { return false; } })();
			const endpoint = counted ? 'get' : 'hit';
			const url = `${base}/${endpoint}/${encodeURIComponent(NS)}/${encodeURIComponent(KEY)}`;
			fetch(url, { method: 'GET', mode: 'cors' })
				.then(r => r.ok ? r.json() : Promise.reject(new Error(`Counter ${r.status}`)))
				.then(data => {
					if (!counted) { try { localStorage.setItem(STORAGE_FLAG, '1'); } catch {} }
					const val = (data && typeof data.value === 'number') ? data.value : 0;
					setNumber(val);
				})
				.catch(() => {/* swallow to avoid UI flicker */});
	}

		function topTopics(repos, limit = 30) {
			const freq = new Map();
			for (const r of repos) {
				for (const t of (r.topics || [])) {
					const k = normalizeTag(t);
					freq.set(k, (freq.get(k) || 0) + 1);
				}
			}
			return [...freq.entries()]
				.sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))
				.slice(0, limit);
		}

		function buildSidebarTags(repos) {
			const items = topTopics(repos, 40);
			elTagsList.innerHTML = items.map(([tag,count]) => (
				`<li><a href="#" data-tag="${escapeHtml(tag)}"><span>#${escapeHtml(tag)}</span><span class="count">${count}</span></a></li>`
			)).join('');
			elTagsList.querySelectorAll('a[data-tag]').forEach(a => {
				a.addEventListener('click', (e) => {
					e.preventDefault();
					const t = a.getAttribute('data-tag');
					const existing = tagsInput.value.trim();
					const parts = existing ? existing.split(/\s+/) : [];
					if (!parts.includes(t)) parts.push(t);
					tagsInput.value = parts.join(' ').trim();
					runSearch();
				});
			});
		}

		function buildSidebarLangs(repos) {
			// Aggregate languages case-insensitively but preserve first-seen casing
			const canon = new Map(); // lower -> original
			const freq = new Map(); // lower -> count
			for (const r of repos) {
				const lang = r && r.language ? String(r.language).trim() : '';
				if (!lang) continue;
				const key = lang.toLowerCase();
				if (!canon.has(key)) canon.set(key, lang);
				freq.set(key, (freq.get(key) || 0) + 1);
			}
			const items = [...freq.entries()]
				.map(([low,count]) => [canon.get(low), count])
				.sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]));
			elLangsList.innerHTML = items.map(([lang,count]) => (
				`<li><a href="#" data-lang="${escapeHtml(lang)}"><span>${escapeHtml(lang)}</span><span class="count">${count}</span></a></li>`
			)).join('');
			elLangsList.querySelectorAll('a[data-lang]').forEach(a => {
				a.addEventListener('click', (e) => {
					e.preventDefault();
					if (elLang) elLang.value = a.getAttribute('data-lang') || '';
					runSearch();
				});
			});
		}

	async function init() {
		try {
			setStatus('Loading repositories…');
			bindEvents();
			updateVisitors();

			const cachedAny = loadCache(false);
			if (cachedAny && Array.isArray(cachedAny) && cachedAny.length) {
				allRepos = cachedAny;
				if (elServing) elServing.textContent = String(allRepos.length);
				updateMoeRepos(allRepos.length);
				buildLanguages(allRepos);
				try {
					const sp = new URL(window.location.href).searchParams;
					const tagsQ = sp.get('tags');
					if (tagsQ && tagsInput) tagsInput.value = tagsQ;
				} catch {}
				runSearch();
				if (elLangsList) buildSidebarLangs(allRepos);
			}

			// Fetch fresh data, fall back to cached if rate limited
			const repos = await fetchAllRepos(cfg.user, cfg.pages);
			allRepos = repos;
			updateCounts(cachedAny ? current.length : 0, allRepos.length);
			if (elServing) elServing.textContent = String(allRepos.length);
			updateMoeRepos(allRepos.length);
			buildLanguages(allRepos);

			// If we're on the list page and have ?tags= in URL, apply it (already applied if from cache)
			if (!cachedAny) {
				try {
					const sp = new URL(window.location.href).searchParams;
					const tagsQ = sp.get('tags');
					if (tagsQ && tagsInput) tagsInput.value = tagsQ;
				} catch {}
				runSearch(); // initial browse
				if (elLangsList) buildSidebarLangs(allRepos);
			}
			Promise.all([
				enrichTopics(allRepos),
				enrichWatchers(allRepos)
			]).then(() => {
				if (elTagsList) buildSidebarTags(allRepos);
				runSearch();
			});
			setStatus('');
		} catch (err) {
			console.error(err);
			setStatus(err.message || 'Failed to load repositories', 'warn');
			elGrid.setAttribute('aria-busy', 'false');
			const cachedAny = loadCache(false);
			if (cachedAny && Array.isArray(cachedAny) && cachedAny.length) {
				allRepos = cachedAny;
				if (elServing) elServing.textContent = String(allRepos.length);
				updateMoeRepos(allRepos.length);
				buildLanguages(allRepos);
				runSearch();
				if (elLangsList) buildSidebarLangs(allRepos);
			} else {
				const msg = (err && err.message || '').toLowerCase();
				// Center the 3-digit code by using two zeros on each side (positions 1-2 and 6-7) => send code * 100
				const code = msg.includes('rate limit') ? 403 : 404;
				const fallbackNum = code * 100; // e.g., 403 => 0040300 (center digits 3-5 show 403)
				updateMoeRepos(fallbackNum, true);
				if (elServing) elServing.textContent = '0';
			}
		}
	}

	init();
})();

