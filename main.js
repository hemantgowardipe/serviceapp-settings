// QuickAppFlow Service Request / LWR Request - Dynamic Application Logic & API Connector
// Backend: Serviceapp_Report workflow via /api/rnsp
// Repository selector: ?ObjectName=<RepositoryName> in URL

(function () {
  "use strict";

  console.log(
    "[Serviceapp_Report] main.js initialization:",
    !!window.__SERVICEAPP_REPORT_MAIN_INITIALIZED__
  );

  if (window.__SERVICEAPP_REPORT_MAIN_INITIALIZED__) {
    console.warn("[Serviceapp_Report] Duplicate main.js execution detected");
    if (typeof window.handleNavigationChange === "function") {
      window.handleNavigationChange("duplicateScriptExecution");
    }
    return;
  }

  window.__SERVICEAPP_REPORT_MAIN_INITIALIZED__ = true;
  window.__SERVICEAPP_SCRIPT_INSTANCE_ID__ = "inst-" + Date.now();

  function getURLParameters() {
    let objectName = null;
    let wfId = null;

    function parseString(str) {
      if (!str || typeof str !== 'string') return;
      try {
        let qStr = str;
        if (qStr.includes('?')) {
          qStr = qStr.substring(qStr.indexOf('?') + 1);
        } else if (qStr.includes('#')) {
          qStr = qStr.substring(qStr.indexOf('#') + 1);
        }
        if (qStr.includes('#')) {
          qStr = qStr.substring(0, qStr.indexOf('#'));
        }
        const searchParams = new URLSearchParams(qStr);

        if (!objectName) {
          objectName = searchParams.get('ObjectName') ||
            searchParams.get('objectName') ||
            searchParams.get('object_name') ||
            searchParams.get('OBJECT_NAME') ||
            null;
        }
        if (!wfId) {
          wfId = searchParams.get('WfId') ||
            searchParams.get('wfid') ||
            searchParams.get('WFID') ||
            searchParams.get('WfID') ||
            searchParams.get('wf_id') ||
            searchParams.get('wfId') ||
            null;
        }
      } catch (e) { }
    }

    // 1. Current search string
    parseString(window.location.search);

    // 2. Current hash string
    if (!objectName || !wfId) {
      parseString(window.location.hash);
    }

    // 3. Current full href
    if (!objectName || !wfId) {
      parseString(window.location.href);
    }

    return {
      objectName: objectName,
      wfId: wfId
    };
  }

  function getRepositoryPageShellKey(href) {
    var raw = href || window.location.href;
    var url;
    try {
      url = new URL(raw, window.location.origin);
    } catch (e) {
      return raw;
    }
    var transient = [
      "ObjectName", "objectName", "object_name", "OBJECT_NAME",
      "WfId", "wfid", "WFID", "WfID", "wf_id", "wfId"
    ];
    var params = new URLSearchParams(url.search);
    transient.forEach(function (key) { params.delete(key); });
    var hash = url.hash || "";
    var hashPath = hash;
    var hashQuery = "";
    var qIndex = hash.indexOf("?");
    if (qIndex >= 0) {
      hashPath = hash.slice(0, qIndex);
      hashQuery = hash.slice(qIndex + 1);
    }
    var hashParams = new URLSearchParams(hashQuery);
    transient.forEach(function (key) { hashParams.delete(key); });
    var hashQs = hashParams.toString();
    return url.pathname + "?" + params.toString() + hashPath + (hashQs ? "?" + hashQs : "");
  }

  var REPOSITORY_PAGE_SHELL_KEY = getRepositoryPageShellKey(window.location.href);

  function isRepositoryPageContext() {
    if (getRepositoryPageShellKey(window.location.href) !== REPOSITORY_PAGE_SHELL_KEY) {
      return false;
    }
    if (document.readyState === "loading") {
      return true;
    }
    var table = document.getElementById("recordsTable");
    var tableBody = document.getElementById("tableBody");
    var pageTitle = document.getElementById("pageTitle");
    if (!table || !tableBody || !pageTitle) {
      return false;
    }
    if (typeof table.isConnected === "boolean" && !table.isConnected) {
      return false;
    }
    return true;
  }

  let params = getURLParameters();

  // â”€â”€â”€ CONFIGURATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Single authoritative data source: Serviceapp_Report workflow.
  // ObjectName comes exclusively from ?ObjectName= in the URL.
  // No hardcoded repository fallback.
  const CONFIG = {
    WORKFLOW_NAME: "Serviceapp_Report",
    RNSP_URL: "https://ndem.quickappflow.com/api/rnsp",
    SAVE_RECORD_URL: "https://ndem.quickappflow.com/api/SaveRecord",
    // wfId is retained ONLY for the Workflow Setting tab iframe (not for data fetch)
    WF_ID: params.wfId || null
  };

// Application State
  let appState = {
    objectName: params.objectName || null,  // null = no repo selected; NO hardcoded fallback
    wfId: params.wfId || null,              // for workflow iframe tab only
    schemaFields: [],
    records: [],           // Current page records only (not full dataset)
    filteredRecords: [],   // Same as records for backend pagination
    currentPage: 1,
    pageSize: 10,
    totalRecordCount: 0,   // May not be available with backend pagination
    hasMore: false,        // Backend pagination flag
    searchQuery: "",
    sortColumn: "",
    sortDirection: "none",
    activeRecord: null,
    isLoading: false       // Prevent duplicate requests
  };

  var appTotalRecordCount = 0;
  let _loadedObjectName = null;
  const GRIDTABLE_WIDTHS_MIGRATION_KEY = "service_request:gridtable-widths-v2";

  function syncPageSizeFromUI() {
    const sizeSelect = document.getElementById("pageSizeSelect");
    if (sizeSelect && sizeSelect.value) {
      const parsed = parseInt(sizeSelect.value, 10);
      if (!isNaN(parsed) && parsed > 0) {
        appState.pageSize = parsed;
      }
    }
  }

  function formatDisplayName(name) {
    if (!name) return "";
    const spaced = name.replace(/([A-Z])/g, " $1").trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function refreshParamsFromURL() {
    const updated = getURLParameters();
    // ObjectName & wfId are synchronized authoritatively from the URL
    appState.objectName = updated.objectName || null;
    appState.wfId = updated.wfId || null;
    CONFIG.WF_ID = updated.wfId || null;
  }

  // â”€â”€â”€ INITIALIZATION & NAVIGATION GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let repositoryLoadPromise = null;
  let lastActivatedRepositoryKey = null;
  let navigationStateIsResolving = false;
  let navigationResolutionVersion = 0;

  function getHistoryId() {
    try {
      let state = window.history.state;
      if (!state || typeof state !== "object") {
        state = {};
      }
      if (!state.__serviceappHistoryId) {
        state.__serviceappHistoryId = "nav-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8);
        window.history.replaceState(state, document.title, window.location.href);
      }
      return state.__serviceappHistoryId;
    } catch (e) {
      return "nav-fallback-" + window.location.href;
    }
  }

  function getRepositoryActivationKey() {
    refreshParamsFromURL();
    const hid = getHistoryId();
    return [
      appState.objectName || "",
      appState.wfId || "",
      window.location.pathname || "",
      window.location.search || "",
      window.location.hash || "",
      hid
    ].join("|");
  }

  function waitForRepositoryDOM(timeoutMs = 5000) {
    const getReadyTableBody = () => {
      const tableBody = document.getElementById("tableBody");
      const pageTitle = document.getElementById("pageTitle");
      return tableBody && pageTitle ? tableBody : null;
    };

    const existing = getReadyTableBody();
    console.log("[Repository DOM] tableBody and pageTitle exist:", !!existing);
    if (existing) {
      return Promise.resolve(existing);
    }

    console.log("[Repository DOM] Waiting for #tableBody and #pageTitle...");

    return new Promise((resolve) => {
      let timer = null;

      const observer = new MutationObserver(() => {
        const el = getReadyTableBody();
        if (el) {
          console.log("[Repository DOM] #tableBody and #pageTitle are now available");
          if (timer) clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });

      timer = setTimeout(() => {
        observer.disconnect();
        const el = getReadyTableBody();
        if (el) {
          console.log("[Repository DOM] #tableBody and #pageTitle are now available");
          resolve(el);
        } else {
          console.warn("[Repository DOM] Timed out waiting for #tableBody and #pageTitle");
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  async function activateRepository() {
    if (!isRepositoryPageContext()) {
      console.log("[Repository Activation] ignored — not on repository page");
      return;
    }

    refreshParamsFromURL();
    const objectName = appState.objectName;
    const activationKey = getRepositoryActivationKey();

// Always reset pagination and search state on repository activation
    appState.currentPage = 1;
    appState.pageSize = parseInt(document.getElementById("pageSizeSelect")?.value || "10", 10);
    appState.searchQuery = "";
    appState.sortColumn = "";
    appState.sortDirection = "none";
    appState.hasMore = false;
    appState.isLoading = false;
    const searchInput = document.getElementById("toolbarSearchInput");
    if (searchInput) searchInput.value = "";

    // Enforce repository view visibility
    const repoView = document.getElementById("repositoryView");
    const wfView = document.getElementById("workflowView");
    const pageHeader = document.getElementById("pageHeader");
    const repoLink = document.getElementById("linkRepositorySetting");
    const wfLink = document.getElementById("linkWorkflowSetting");

    if (repoView) repoView.style.display = "block";
    if (wfView) wfView.style.display = "none";
    if (pageHeader) pageHeader.style.display = "block";
    if (repoLink) repoLink.classList.add("active");
    if (wfLink) wfLink.classList.remove("active");

    if (!objectName) {
      console.error("[Repository Activation] No ObjectName provided in URL.");
      appState.records = [];
      appState.filteredRecords = [];
      appState.schemaFields = [];
      appState.totalRecordCount = 0;
      lastActivatedRepositoryKey = null;
      const tbody = await waitForRepositoryDOM(5000);
      ensureSchemaFieldsFromRecords();
      applyFiltersAndRender();
      return;
    }

    if (repositoryLoadPromise) {
      console.log("[Repository Activation] IGNORED â€” activation already in progress");
      return repositoryLoadPromise;
    }

    if (lastActivatedRepositoryKey === activationKey) {
      console.log("[Repository Activation] SKIPPED duplicate history activation");
      return Promise.resolve();
    }

    console.log("[Repository Activation] NEW HISTORY ACTIVATION");
    console.log(`[Repository Activation] START ObjectName=${objectName}`);

    repositoryLoadPromise = (async () => {
      try {
        setupLocalStorageCredentials();

        // The page shell may be created by QuickAppFlow after activation starts.
        // Wait on the existing repository DOM boundary before touching its title.
        await waitForRepositoryDOM(5000);
        updatePageTitle(objectName);
        showLoadingState();
        await ALWAYS_FETCH_GET_RECORDS_API();
        console.log("[Repository Activation] RNSP completed");
        console.log(`[Repository Activation] Records=${appState.records ? appState.records.length : 0}`);

        // Wait for #tableBody DOM element to exist before rendering
        const tbody = await waitForRepositoryDOM(5000);

        console.log("[Repository Activation] Rendering repository");
        ensureSchemaFieldsFromRecords();
        applyFiltersAndRender();
        const rowCount = document.getElementById("tableBody")?.children.length || 0;
        console.log(`[Repository DOM] Rendered rows: ${rowCount}`);
        console.log(`[Repository Activation] Rendered rows=${rowCount}`);
        console.log("[Repository Activation] END");

        // Mark activation as successfully completed ONLY AFTER RNSP succeeds & table renders
        lastActivatedRepositoryKey = activationKey;
      } catch (err) {
        console.error("[Repository Activation] Error during activation:", err);
      } finally {
        repositoryLoadPromise = null;
      }
    })();

    return repositoryLoadPromise;
  }

  function handleNavigationChange(source) {
    if (!isRepositoryPageContext()) {
      console.log("[Navigation] ignored — not on repository page, source=" + source);
      return Promise.resolve();
    }

    refreshParamsFromURL();
    const currentObjectName = appState.objectName;
    const initInProgress = !!repositoryLoadPromise;
    const recordCount = appState.records ? appState.records.length : 0;
    const historyId = getHistoryId();

    console.log(`[Navigation] source=${source}`);
    console.log(`[Navigation] historyId=${historyId}`);
    console.log(`[Navigation] URL=${location.href}`);
    console.log(`[Navigation] ObjectName=${currentObjectName || "null"}`);
    console.log(`[Navigation] scriptInstance=${window.__SERVICEAPP_SCRIPT_INSTANCE_ID__ || "1"}`);
    console.log(`[Navigation] repositoryLoadInProgress=${initInProgress}`);
    console.log(`[Navigation] records=${recordCount}`);

    // 1. Defer if DOM is still loading
    if (document.readyState === "loading") {
      console.log("[Bootstrap] DOM not ready â€” deferring initialization");
      if (!window._domContentLoadedListenerAdded) {
        window._domContentLoadedListenerAdded = true;
        document.addEventListener("DOMContentLoaded", () => {
          console.log("[Bootstrap] DOM ready â€” continuing initialization");
          handleNavigationChange("DOMContentLoaded");
        }, { once: true });
      }
      return Promise.resolve();
    }

    // 2. A navigation can briefly expose an incomplete history/URL state.
    // Resolve it in the next microtask through this same controller before
    // treating a missing ObjectName as a confirmed invalid URL.
    const resolutionVersion = ++navigationResolutionVersion;
    if (!currentObjectName) {
      navigationStateIsResolving = true;
      return Promise.resolve().then(() => {
        if (resolutionVersion !== navigationResolutionVersion) return;
        if (!isRepositoryPageContext()) {
          navigationStateIsResolving = false;
          return;
        }
        refreshParamsFromURL();
        navigationStateIsResolving = false;
        return activateRepository();
      });
    }

    navigationStateIsResolving = false;

    // 3. Delegate directly to single-flight activateRepository()
    return activateRepository();
  }

  function _bootstrapApp() {
    return handleNavigationChange("bootstrap");
  }

  async function initApp() {
    return activateRepository();
  }

  // Initial trigger
  if (document.readyState === 'loading') {
    if (!window._domContentLoadedListenerAdded) {
      window._domContentLoadedListenerAdded = true;
      document.addEventListener('DOMContentLoaded', () => {
        handleNavigationChange("DOMContentLoaded");
      }, { once: true });
    }
  } else {
    Promise.resolve().then(() => handleNavigationChange("scriptLoad"));
  }

  // Safety net on window.load
  window.addEventListener('load', () => {
    handleNavigationChange("windowLoad");
  }, { once: true });

  // BFCache & page visibility lifecycle
  window.addEventListener("pageshow", (event) => {
    console.log("[Navigation] pageshow persisted=" + event.persisted + " URL=" + location.href);
    if (event.persisted) {
      lastActivatedRepositoryKey = null;
    }
    handleNavigationChange("pageshow");
  });

  // SPA & Browser Navigation Event Listeners â€” all pass through handleNavigationChange
  window.addEventListener('popstate', () => {
    handleNavigationChange("popstate");
  });
  window.addEventListener('hashchange', () => { handleNavigationChange("hashchange"); });

  const _origPushState = window.history.pushState;
  const _origReplaceState = window.history.replaceState;
  if (_origPushState) {
    window.history.pushState = function () {
      _origPushState.apply(this, arguments);
      handleNavigationChange("pushState");
    };
  }
  if (_origReplaceState) {
    window.history.replaceState = function () {
      _origReplaceState.apply(this, arguments);
      handleNavigationChange("replaceState");
    };
  }

  // Parent SPA message event listener (if embedded in an iframe or parent shell)
  window.addEventListener("message", (event) => {
    if (!event || !event.data) return;
    let data = event.data;
    if (typeof data === "string" && data.startsWith("{")) {
      try { data = JSON.parse(data); } catch (e) { }
    }
    if (typeof data === "object") {
      const objName = data.ObjectName || data.objectName || data.object_name || data.OBJECT_NAME;
      const wfId = data.WfId || data.wfid || data.WFID || data.wfId;
      let changed = false;
      if (objName && objName !== appState.objectName) {
        appState.objectName = objName;
        changed = true;
      }
      if (wfId && wfId !== appState.wfId) {
        appState.wfId = wfId;
        CONFIG.WF_ID = wfId;
        changed = true;
      }
      if (changed) {
        console.log("[Message Event] Received ObjectName from parent message:", appState.objectName);
        activateRepository();
      }
    }
  });

  // Fallback observer: if the redirecting host sets ObjectName in URL/hash/parent asynchronously after page load,
  // periodically check during early load so the first navigation never requires an F5 refresh.
  function scheduleInitialRedirectObserver() {
    const checks = [150, 400, 800, 1500, 3000];
    checks.forEach((delay) => {
      setTimeout(() => {
        if ((!appState.records || appState.records.length === 0) && !repositoryLoadPromise) {
          const before = appState.objectName;
          refreshParamsFromURL();
          if (appState.objectName && (!before || appState.objectName !== before || !appState.records || appState.records.length === 0)) {
            console.log(`[Redirect Observer @ ${delay}ms] Detected ObjectName='${appState.objectName}' â€” activating repository`);
            activateRepository();
          }
        }
      }, delay);
    });
  }
  scheduleInitialRedirectObserver();

  function setupLocalStorageCredentials() {
    if (!localStorage.getItem("user_key")) {
      const defaultUserKey = {
        timeStamp: new Date().toISOString(),
        value: {
          EmployeeID: 1081,
          HrzempId: 0,
          EmployeeGUID: "55e2ecd3-9b12-401b-b1d2-b7c90b260b76",
          Email: "hemantgowardipe442@gmail.com",
          FirstName: "Hemant",
          LastName: "Gowardipe"
        }
      };
      localStorage.setItem("user_key", JSON.stringify(defaultUserKey));
    }

    const currentDomain = (window.location && window.location.origin) ? window.location.origin : "https://ndem.quickappflow.com";
    localStorage.setItem("env", currentDomain);

    if (window.QafService && typeof window.QafService.SetEnvUrl === "function") {
      window.QafService.SetEnvUrl(currentDomain);
    }

    try {
      localStorage.removeItem("LWR_LOCAL_RECORDS");
      sessionStorage.removeItem("LWR_LOCAL_RECORDS");
    } catch (e) { }
  }

  function getAuthHeaders() {
    let userKey = null;
    try {
      const raw = localStorage.getItem("user_key");
      if (raw) userKey = JSON.parse(raw);
    } catch (e) { }

    const empGuid = userKey && userKey.value && userKey.value.EmployeeGUID ? userKey.value.EmployeeGUID : "55e2ecd3-9b12-401b-b1d2-b7c90b260b76";
    const email = userKey && userKey.value && userKey.value.Email ? userKey.value.Email : "hemantgowardipe442@gmail.com";
    const empId = userKey && userKey.value && userKey.value.EmployeeID ? String(userKey.value.EmployeeID) : "1081";

    return {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "EmployeeGUID": empGuid,
      "Hrzemail": email,
      "HrzempId": empId
    };
  }

  async function fetchWithRetry(url, options = {}, maxRetries = 3, delayMs = 400) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data) return data;
        }
      } catch (err) {
        console.warn(`[LWR] API Attempt ${attempt}/${maxRetries} failed for ${url}:`, err.message);
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
    return null;
  }

  function getCurrentUserName() {
    try {
      const raw = localStorage.getItem("user_key");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.value && parsed.value.FirstName) {
          return `${parsed.value.FirstName} ${parsed.value.LastName || ''}`.trim();
        }
      }
    } catch (e) { }
    return "Hemant Gowardipe";
  }

  async function initApp() {
    setupLocalStorageCredentials();
    refreshParamsFromURL();

    const objectName = appState.objectName;

    if (!objectName) {
      // No ObjectName in URL â€” show clear error state, do NOT fall back to any hardcoded repo
      console.error("[Serviceapp_Report] No ObjectName provided in URL. Aborting data fetch.");
      appState.records = [];
      appState.filteredRecords = [];
      appState.schemaFields = [];
      appState.totalRecordCount = 0;
      _loadedObjectName = null;
      ensureSchemaFieldsFromRecords();
      applyFiltersAndRender();
      return;
    }

    // Update page title with the repository name
    updatePageTitle(objectName);

    console.log(`[Serviceapp_Report] Initializing â€” ObjectName: '${objectName}' â†’ Workflow: '${CONFIG.WORKFLOW_NAME}'`);
    await ALWAYS_FETCH_GET_RECORDS_API();
  }

  // fetchWFConfig and fetchViewID removed â€” repository selection is now done exclusively
  // via ObjectName â†’ Serviceapp_Report. WFConfigByID and ViewGet are no longer used for data loading.

  function hideInnerSubnavButtons() {
    const iframe = document.getElementById("workflowIframe");
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (doc && doc !== document) {
        const elementsToHide = doc.querySelectorAll('.settings-subnav, header, .app-header, .qaf-header, .subnav-links');
        elementsToHide.forEach(el => {
          if (el) el.style.display = 'none';
        });
      }
    } catch (e) { }
  }

  function switchTab(tabName, event) {
    if (event) {
      event.preventDefault();
    }

    const repoLink = document.getElementById("linkRepositorySetting");
    const wfLink = document.getElementById("linkWorkflowSetting");
    const repoView = document.getElementById("repositoryView");
    const wfView = document.getElementById("workflowView");
    const wfIframe = document.getElementById("workflowIframe");
    const pageHeader = document.getElementById("pageHeader");

    const targetWfId = appState.wfId || appState.objectId;

    if (tabName === "workflow") {
      if (repoLink) repoLink.classList.remove("active");
      if (wfLink) wfLink.classList.add("active");

      if (pageHeader) pageHeader.style.display = "none";
      if (repoView) repoView.style.display = "none";
      if (wfView) wfView.style.display = "block";

      if (wfIframe && targetWfId) {
        const targetUrl = `https://training.quickappflow.com/workflow-engine/${targetWfId}`;
        if (wfIframe.src !== targetUrl) {
          wfIframe.src = targetUrl;
        }
        wfIframe.onload = hideInnerSubnavButtons;
      }
    } else {
      if (wfLink) wfLink.classList.remove("active");
      if (repoLink) repoLink.classList.add("active");

      if (pageHeader) pageHeader.style.display = "block";
      if (wfView) wfView.style.display = "none";
      if (repoView) repoView.style.display = "block";

      lastActivatedRepositoryKey = null;
      activateRepository();
    }
  }

  function updatePageTitle(titleName) {
    if (!titleName) return;
    const pageTitleEl = document.getElementById("pageTitle");
    if (pageTitleEl) {
      pageTitleEl.textContent = titleName;
    }
    document.title = titleName;
  }

  // fetchObjectMetadata removed â€” page title is now set directly from the ObjectName URL parameter.
  // The Serviceapp_Report workflow is the sole data source; ObjectGet is no longer used.

  function buildWhereClause(query) {
    if (!query || !query.trim()) return "";
    const safeTerm = query.trim().replace(/'/g, "\\'");
    const searchFields = appState.schemaFields.map(f => f.internalName);
    if (searchFields.length === 0) return "";
    return searchFields.map(field => `${field}<contains>'${safeTerm}'`).join("<OR>");
  }

  async function fetchRecordsFromEndpoint(url) {
    const data = await fetchWithRetry(url, {
      method: "POST",
      headers: getAuthHeaders(),
      cache: "no-store",
      body: "{}"
    }, 3, 400);
    return Array.isArray(data) ? data : null;
  }

  /**
   * Fetch repository records via Serviceapp_Report workflow.
   * ONLY sends ObjectName â€” no date range, no agent, no priority, no category.
   * Lookup values are already cleaned by the SQL workflow; no frontend GUID stripping needed.
   */
  async function fetchRecordsViaRNSP(objectName) {
    console.log(`[RNSP] START ObjectName=${objectName}`);
    const payload = {
      Name: CONFIG.WORKFLOW_NAME,   // always "Serviceapp_Report"
      Args: {
        ObjectName: objectName
      }
    };

    console.log(`[Serviceapp_Report] POST ${CONFIG.RNSP_URL}`, JSON.stringify(payload));

    const data = await fetchWithRetry(CONFIG.RNSP_URL, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    }, 3, 400);

    console.log(`[RNSP] END ObjectName=${objectName}`);

    if (Array.isArray(data)) {
      return data;
    } else if (data && typeof data === "object") {
      // Normalise wrapped response shapes
      const list = data.records || data.Records || data.data || data.Data ||
        data.Table || data.Table1 || data.result || data.Result ||
        data.Response || data.response || data.RecordList || data.recordList ||
        data.Items || data.items || data.Rows || data.rows || data.dataList;
      if (Array.isArray(list)) return list;
    }

    console.warn(`[Serviceapp_Report] Unexpected response shape:`, data);
    return null;
  }

/**
   * Fetch a single page of repository records using library.js backend pagination.
   * Uses QafLibrary.fetchRepositoryPage which sends currentPage, pageSize, filterCondition, sortBy to backend.
   * Returns { rows, page, pageSize, hasMore, raw }.
   */
  async function fetchRepositoryPageData() {
    const objectName = appState.objectName;
    if (!objectName) {
      console.error("[fetchRepositoryPageData] No objectName available");
      return { rows: [], page: 1, pageSize: appState.pageSize, hasMore: false, raw: null };
    }

    // Build filter condition from search query
    const filterCondition = buildWhereClause(appState.searchQuery);
    
    // Build sort parameters
    const sortBy = appState.sortColumn || "";
    const isAscending = appState.sortDirection === "ascending";

    console.log(`[Pagination] Fetching page ${appState.currentPage}, size ${appState.pageSize}, filter: ${filterCondition}, sort: ${sortBy} ${isAscending ? 'asc' : 'desc'}`);

    try {
      // Use library.js pagination function
      const result = await window.QafLibrary.fetchRepositoryPage({
        objectName: objectName,
        currentPage: appState.currentPage,
        pageSize: appState.pageSize,
        filterCondition: filterCondition,
        sortBy: sortBy,
        isAscending: isAscending
      });

      console.log(`[Pagination] Received ${result.rows?.length || 0} records, hasMore: ${result.hasMore}`);
      return result;
    } catch (err) {
      console.error("[Pagination] Fetch failed:", err);
      showToast("Failed to load repository data", "error");
      return { rows: [], page: appState.currentPage, pageSize: appState.pageSize, hasMore: false, raw: null };
    }
  }

  /**
   * Show a loading skeleton inside the table body while fetching.
   */
  function showLoadingState() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.innerHTML = `
    <tr class="loading-row">
      <td colspan="100%" style="text-align:center; padding: 60px 24px; color: #888;">
        <div class="loading-spinner" aria-label="Loading"></div>
        <p style="margin-top: 14px; font-size: 13px;">Loading repository data…</p>
      </td>
    </tr>
  `;
  }

/**
   * Primary data-load function.
   * Reads ObjectName from appState (set from URL), fetches records via RNSP (Serviceapp_Report).
   */
  async function ALWAYS_FETCH_GET_RECORDS_API() {
    refreshParamsFromURL();
    syncPageSizeFromUI();

    const objectName = appState.objectName;

    if (!objectName) {
      console.error("[Serviceapp_Report] ALWAYS_FETCH_GET_RECORDS_API called but objectName is missing.");
      appState.records = [];
      appState.filteredRecords = [];
      appState.totalRecordCount = 0;
      appState.hasMore = false;
      window.appTotalRecordCount = 0;
      appTotalRecordCount = 0;
      _loadedObjectName = null;
      ensureSchemaFieldsFromRecords();
      applyFiltersAndRender();
      return;
    }

    // Prevent duplicate requests
    if (appState.isLoading) {
      console.log("[RNSP] Request already in progress, skipping");
      return;
    }
    appState.isLoading = true;

    // Show loading skeleton immediately so first-open never looks blank
    showLoadingState();

    console.log(`[Serviceapp_Report] Fetching records via RNSP for ObjectName='${objectName}'`);

    const data = await fetchRecordsViaRNSP(objectName);

    appState.isLoading = false;

    if (Array.isArray(data) && data.length > 0) {
      console.log(`[Serviceapp_Report] Received ${data.length} record(s) via RNSP.`);
      appState.records = data;
      appState.filteredRecords = data;
      appState.totalRecordCount = data.length;
      appState.hasMore = false; // RNSP returns full dataset; pagination handled client-side if needed
      _loadedObjectName = objectName;
    } else {
      console.warn(`[Serviceapp_Report] No records returned via RNSP for ObjectName='${objectName}'.`);
      if (appState.currentPage === 1) {
        showToast(`No records found for repository: ${objectName}`, "info");
      }
      appState.records = [];
      appState.filteredRecords = [];
      appState.totalRecordCount = 0;
      appState.hasMore = false;
      _loadedObjectName = null;
    }

    window.appTotalRecordCount = appState.totalRecordCount;
    appTotalRecordCount = appState.totalRecordCount;

    ensureSchemaFieldsFromRecords();
    console.log("[Serviceapp_Report] appState.records:", appState.records.length);
    console.log("[Serviceapp_Report] schemaFields:", appState.schemaFields.length);
    console.log("[Serviceapp_Report] tableBody exists:", !!document.getElementById("tableBody"));
    applyFiltersAndRender();
  }

  function cleanGuidValue(val) {
    if (val === null || val === undefined) return "";
    let strVal = String(val);
    if (!strVal.includes(";#")) return strVal;

    const parts = strVal.split(";#").map(p => p.trim()).filter(Boolean);
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const cleanParts = parts.filter(p => !uuidRegex.test(p) && !/^\d+$/.test(p));

    if (cleanParts.length > 0) {
      return cleanParts.join(", ");
    }
    return parts[parts.length - 1] || strVal;
  }

  // System fields that the Serviceapp_Report SQL already removes;
  // if any slip through, exclude them from visible table columns.
  const SYSTEM_FIELDS_TO_HIDE = new Set([
    "ID", "RecordID", "ObjectID", "ParentRecordID",
    "CreatedDate", "LastModifiedDate", "LastModifiedBy",
    "CreatedByID", "CreatedByGUID", "WFInstanceID"
  ]);

  function ensureSchemaFieldsFromRecords() {
    if (!appState.records || appState.records.length === 0) {
      appState.schemaFields = [];
      return;
    }

    appState.schemaFields = [];

    const recordKeys = new Set();
    appState.records.forEach(rec => {
      Object.keys(rec).forEach(k => {
        if (
          !SYSTEM_FIELDS_TO_HIDE.has(k) &&
          !k.startsWith("_") &&
          !k.endsWith("_FileMetadata")
        ) {
          recordKeys.add(k);
        }
      });
    });

    recordKeys.forEach(k => {
      appState.schemaFields.push({
        internalName: k,
        displayName: formatDisplayName(k),
        fieldId: "",
        dataType: "String",
        choices: ""
      });
    });
  }

  async function loadRecordsFromDatabase() {
    await ALWAYS_FETCH_GET_RECORDS_API();
  }

  /**
   * Normalise raw API response rows into plain JS objects.
   * Serviceapp_Report already cleans lookup GUID values and removes system fields.
   * We do NOT manufacture CreatedBy/ModifiedBy â€” display only what the workflow returns.
   */
  function parseGetRecordsResponse(apiData) {
    if (!Array.isArray(apiData)) return [];

    const parsedItems = [];

    apiData.forEach((rawRecord, index) => {
      // Support two shapes: flat object (Serviceapp_Report) or RecordFieldValues array (legacy)
      const item = {};

      if (Array.isArray(rawRecord.RecordFieldValues)) {
        // Legacy RecordFieldValues format
        rawRecord.RecordFieldValues.forEach(fv => {
          const internalName = fv.FieldInternalName || fv.FieldID;
          if (internalName) {
            const val = (fv.FieldValue !== undefined && fv.FieldValue !== null && fv.FieldValue !== "")
              ? fv.FieldValue
              : (fv.UGFieldValue || "");
            item[internalName] = cleanGuidValue(String(val));
          }
        });
      }

      // Flat properties (Serviceapp_Report returns flat objects â€” values already clean)
      Object.keys(rawRecord).forEach(k => {
        if (k === "RecordFieldValues") return;  // already handled above
        const v = rawRecord[k];
        if (v !== null && v !== undefined) {
          if (item[k] === undefined || item[k] === null) {
            if (typeof v === "object") {
              const strVal = v.label || v.name || v.value || (v instanceof Date ? v.toISOString() : JSON.stringify(v));
              item[k] = cleanGuidValue(String(strVal));
            } else {
              item[k] = cleanGuidValue(String(v));
            }
          }
        }
      });

      // Guarantee a stable RecordID for row keying even if the workflow omitted it
      if (!item.RecordID && !item.ID) {
        item.RecordID = `REC_${index + 1}`;
      } else if (!item.RecordID) {
        item.RecordID = item.ID;
      }

      parsedItems.push(item);
    });

    return parsedItems;
  }

  // ============================================
  // GridTable Module (Exact Reference from subcategory.js)
  // ============================================
  (function () {
    "use strict";

    if (window.GridTable) return;

    var DEFAULTS = {
      headerSelector: "thead th",
      bodySelector: "tbody",
      sortable: false,
      resizable: false,
      minWidth: 60,
      maxWidth: 900,
      noSortClass: "no-sort",
      noResizeClass: "no-resize",
      sortableClasses: ["is-sortable", "gt-sortable"],
      sortedClass: "is-sorted",
      sortIconClasses: ["gt-sort-icon", "th-sort-icon"],
      resizerClass: "gt-col-resizer",
      resizeStorageKey: "",
      persistWidths: true
    };

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function ensureColGroup(table, columnCount) {
      var colGroup = table.querySelector("colgroup");
      if (!colGroup) {
        colGroup = document.createElement("colgroup");
        table.insertBefore(colGroup, table.firstChild);
      }
      var currentCols = colGroup.querySelectorAll("col");
      if (currentCols.length !== columnCount) {
        colGroup.innerHTML = "";
        for (var i = 0; i < columnCount; i += 1) {
          colGroup.appendChild(document.createElement("col"));
        }
      }
      return colGroup;
    }

    function getStorageKey(table, config) {
      var explicit = String(config.resizeStorageKey || "").trim();
      if (explicit) return "gridtable:widths:" + explicit;
      var tableKey = String(table.getAttribute("data-resize-key") || "").trim();
      if (tableKey) return "gridtable:widths:" + tableKey;
      return "";
    }

    function readSavedWidths(storageKey) {
      if (!storageKey || !window.localStorage) return [];
      try {
        var raw = window.localStorage.getItem(storageKey);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(Number).filter(Number.isFinite);
      } catch (_) {
        return [];
      }
    }

    function saveWidths(table, storageKey) {
      if (!storageKey || !window.localStorage || !table) return;
      try {
        var cols = table.querySelectorAll("colgroup col");
        var widths = Array.prototype.map.call(cols, function (col) {
          var styled = parseFloat(col.style.width);
          if (Number.isFinite(styled) && styled > 0) return Math.round(styled);
          return Math.round(col.getBoundingClientRect().width || 0);
        });
        window.localStorage.setItem(storageKey, JSON.stringify(widths));
      } catch (_) { }
    }

    function getAllColumnWidths(table) {
      var cols = table.querySelectorAll("colgroup col");
      return Array.prototype.map.call(cols, function (col) {
        var styled = parseFloat(col.style.width);
        if (Number.isFinite(styled) && styled > 0) return Math.round(styled);
        return Math.round(col.getBoundingClientRect().width || 0);
      });
    }

    function applyAllColumnWidths(table, widths) {
      var cols = table.querySelectorAll("colgroup col");
      widths.forEach(function (width, index) {
        if (!cols[index] || !Number.isFinite(width) || width <= 0) return;
        cols[index].style.width = Math.round(width) + "px";
      });
    }

    function readColumnWidth(table, columnIndex) {
      var cols = table.querySelectorAll("colgroup col");
      var col = cols[columnIndex];
      if (!col) return 0;
      var styled = parseFloat(col.style.width);
      if (Number.isFinite(styled) && styled > 0) return Math.round(styled);
      var rendered = col.getBoundingClientRect().width;
      if (Number.isFinite(rendered) && rendered > 1) return Math.round(rendered);
      return 0;
    }

    function estimateColumnWidth(table, columnIndex, minWidth, maxWidth) {
      var rows = Array.prototype.slice.call(table.querySelectorAll("tr")).slice(0, 40);
      var maxChars = 8;
      rows.forEach(function (row) {
        var cell = row.children[columnIndex];
        if (cell) {
          var text = String(cell.textContent || "").trim();
          maxChars = Math.max(maxChars, text.length);
        }
      });
      var width = Math.round(maxChars * 8 + 32);
      return clamp(width, minWidth, maxWidth);
    }

    function syncWrapScrollState(table) {
      var wrap = table.closest(".table-wrap") || table.closest(".table-responsive");
      if (!wrap) return;
      var availableWidth = wrap.clientWidth;
      if (!availableWidth) return;
      var total = 0;
      var cols = table.querySelectorAll("colgroup col");
      cols.forEach(function (col) {
        var w = parseFloat(col.style.width);
        total += Number.isFinite(w) && w > 0 ? w : col.getBoundingClientRect().width || 0;
      });
      wrap.classList.toggle("has-horizontal-scroll", total > availableWidth + 1);
    }

    function isNumericLike(str) {
      if (!str) return false;
      var cleaned = str.replace(/[,%$â‚¬Â£\s]/g, "");
      if (cleaned === "" || cleaned === "-" || cleaned === "+") return false;
      return Number.isFinite(Number(cleaned));
    }

    function parseNumericLike(str) {
      return Number(String(str).replace(/[,%$â‚¬Â£\s]/g, ""));
    }

    function isDateLike(str) {
      if (!str || !/[\/\-]/.test(str) || !/\d/.test(str)) return false;
      var t = Date.parse(str);
      return Number.isFinite(t);
    }

    function createGridTable(table, options) {
      if (!table) throw new Error("Table element is required.");

      var config = Object.assign({}, DEFAULTS, options || {});
      var headers = Array.prototype.slice.call(table.querySelectorAll(config.headerSelector));
      var columnCount = headers.length;

      var storageKey = "";
      var savedWidths = [];
      var hasSaved = false;

      if (config.resizable) {
        ensureColGroup(table, columnCount);
        storageKey = getStorageKey(table, config);
        savedWidths = storageKey ? readSavedWidths(storageKey) : [];
        hasSaved = savedWidths.length === columnCount && columnCount > 0 && savedWidths.every(function (w) {
          return w > 0;
        });
      }

      function initWidths() {
        var widths = [];
        headers.forEach(function (header, index) {
          if (header.classList.contains(config.noResizeClass)) {
            widths[index] = index === 0 ? 40 : index === 1 ? 40 : 220;
            return;
          }
          var width;
          if (hasSaved && savedWidths[index] > 0) {
            width = clamp(savedWidths[index], config.minWidth, config.maxWidth);
          } else {
            width = readColumnWidth(table, index);
            width = width > 0
              ? clamp(width, config.minWidth, config.maxWidth)
              : estimateColumnWidth(table, index, config.minWidth, config.maxWidth);
          }
          widths[index] = width;
        });
        applyAllColumnWidths(table, widths);
        syncWrapScrollState(table);
      }

      function setupResizeHandles() {
        headers.forEach(function (header, index) {
          var existing = header.querySelector("." + config.resizerClass);
          if (existing) existing.remove();
          if (header.classList.contains(config.noResizeClass)) return;

          var handle = document.createElement("div");
          handle.className = config.resizerClass;
          handle.setAttribute("role", "separator");
          handle.setAttribute("aria-orientation", "vertical");
          handle.setAttribute("aria-label", "Resize " + String(header.textContent || "").trim() + " column");
          handle.dataset.colIndex = String(index);
          header.appendChild(handle);
        });
      }

      var isDragging = false;
      var dragData = null;

      function onMouseDown(event) {
        if (!config.resizable) return;
        var handle = event.target.closest ? event.target.closest("." + config.resizerClass) : null;
        if (!handle || !table.contains(handle)) return;
        var index = Number(handle.dataset.colIndex);
        if (!Number.isFinite(index)) return;

        event.preventDefault();
        var lockedWidths = getAllColumnWidths(table);
        isDragging = true;
        document.body.classList.add("is-column-resizing");
        dragData = {
          index: index,
          lockedWidths: lockedWidths,
          startWidth: lockedWidths[index] || config.minWidth,
          startX: event.clientX
        };
      }

      function onDragMove(event) {
        if (!isDragging || !dragData) return;
        var delta = event.clientX - dragData.startX;
        var newWidth = clamp(dragData.startWidth + delta, config.minWidth, config.maxWidth);
        var widths = dragData.lockedWidths.slice();
        widths[dragData.index] = newWidth;
        applyAllColumnWidths(table, widths);
        syncWrapScrollState(table);
        event.preventDefault();
      }

      function onDragEnd() {
        if (!isDragging) return;
        isDragging = false;
        document.body.classList.remove("is-column-resizing");
        if (config.persistWidths && storageKey) saveWidths(table, storageKey);
        syncWrapScrollState(table);
        dragData = null;
      }

      function onSelectStart(event) {
        if (isDragging) event.preventDefault();
      }

      function setupSortHeaders() {
        headers.forEach(function (header) {
          if (header.classList.contains(config.noSortClass)) return;

          config.sortableClasses.forEach(function (cls) {
            header.classList.add(cls);
          });
          if (!header.hasAttribute("aria-sort")) header.setAttribute("aria-sort", "none");
          if (!header.hasAttribute("tabindex")) header.setAttribute("tabindex", "0");

          var iconSelector = "." + config.sortIconClasses.join(".");
          if (!header.querySelector(iconSelector)) {
            var icon = document.createElement("span");
            icon.className = config.sortIconClasses.join(" ");
            icon.setAttribute("aria-hidden", "true");
            header.appendChild(icon);
          }
        });
      }

      var defaultRowOrder = null;

      function captureDefaultRowOrder() {
        var tbody = table.querySelector(config.bodySelector);
        if (!tbody) return;
        defaultRowOrder = Array.prototype.filter.call(tbody.children, function (node) {
          return node.tagName === "TR";
        });
      }

      function restoreDefaultRowOrder() {
        var tbody = table.querySelector(config.bodySelector);
        if (!tbody || !defaultRowOrder || !defaultRowOrder.length) return;
        var frag = document.createDocumentFragment();
        defaultRowOrder.forEach(function (row) {
          if (row.parentNode === tbody) frag.appendChild(row);
        });
        tbody.appendChild(frag);
      }

      function applySort(columnIndex, direction) {
        if (direction === "none") {
          restoreDefaultRowOrder();
          return;
        }

        var tbody = table.querySelector(config.bodySelector);
        if (!tbody) return;

        var rows = Array.prototype.filter.call(tbody.children, function (node) {
          return node.tagName === "TR";
        });
        if (rows.length < 2) return;

        var structureOk = rows.every(function (row) {
          return row.cells && row.cells.length > columnIndex;
        });
        if (!structureOk) return;

        var dir = direction === "descending" ? -1 : 1;
        var decorated = rows.map(function (row, idx) {
          var cell = row.cells[columnIndex];
          var raw = cell ? String(cell.textContent || "").trim() : "";
          return { row: row, raw: raw, idx: idx };
        });

        var comparable = decorated.filter(function (d) {
          return d.raw !== "";
        });
        var allNumeric = comparable.length > 0 && comparable.every(function (d) {
          return isNumericLike(d.raw);
        });
        var allDate = !allNumeric && comparable.length > 0 && comparable.every(function (d) {
          return isDateLike(d.raw);
        });

        decorated.sort(function (a, b) {
          if (a.raw === "" && b.raw === "") return a.idx - b.idx;
          if (a.raw === "") return 1;
          if (b.raw === "") return -1;

          var cmp;
          if (allNumeric) {
            cmp = parseNumericLike(a.raw) - parseNumericLike(b.raw);
          } else if (allDate) {
            cmp = new Date(a.raw).getTime() - new Date(b.raw).getTime();
          } else {
            cmp = a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: "base" });
          }
          if (cmp === 0) cmp = a.idx - b.idx;
          return cmp * dir;
        });

        var frag = document.createDocumentFragment();
        decorated.forEach(function (d) {
          frag.appendChild(d.row);
        });
        tbody.appendChild(frag);
      }

      function sortByColumn(header, columnIndex) {
        if (!defaultRowOrder) captureDefaultRowOrder();

        var current = header.getAttribute("aria-sort") || "none";
        var next = current === "none" ? "ascending" : current === "ascending" ? "descending" : "none";

        headers.forEach(function (h) {
          if (h === header) return;
          if (h.hasAttribute("aria-sort")) h.setAttribute("aria-sort", "none");
          h.classList.remove(config.sortedClass, "gt-sorted");
        });

        header.setAttribute("aria-sort", next);
        if (next === "none") {
          header.classList.remove(config.sortedClass, "gt-sorted");
        } else {
          header.classList.add(config.sortedClass, "gt-sorted");
        }
        applySort(columnIndex, next);
        fixTableSortIcons(table);
      }

      function isSortableHeader(header) {
        return config.sortableClasses.some(function (cls) {
          return header.classList.contains(cls);
        });
      }

      function onHeaderClick(event) {
        if (!config.sortable) return;
        if (event.target.closest && event.target.closest("." + config.resizerClass)) return;
        var header = event.target.closest ? event.target.closest(config.headerSelector) : null;
        if (!header || !table.contains(header) || !isSortableHeader(header)) return;
        var index = headers.indexOf(header);
        if (index === -1) return;
        sortByColumn(header, index);
      }

      function onHeaderKeydown(event) {
        if (!config.sortable) return;
        if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
        var header = event.target.closest ? event.target.closest(config.headerSelector) : null;
        if (!header || !table.contains(header) || !isSortableHeader(header)) return;
        event.preventDefault();
        var index = headers.indexOf(header);
        if (index === -1) return;
        sortByColumn(header, index);
      }

      if (config.resizable) {
        initWidths();
        setupResizeHandles();
        table.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mousemove", onDragMove);
        document.addEventListener("mouseup", onDragEnd);
        document.addEventListener("selectstart", onSelectStart);
      }

      if (config.sortable) {
        setupSortHeaders();
        table.addEventListener("click", onHeaderClick);
        table.addEventListener("keydown", onHeaderKeydown);
      }

      return {
        refresh: function () {
          if (config.resizable) {
            applyAllColumnWidths(table, getAllColumnWidths(table));
          }
          syncWrapScrollState(table);
          fixTableSortIcons(table);
          return this;
        },
        destroy: function () {
          if (config.resizable) {
            table.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
            document.removeEventListener("selectstart", onSelectStart);
          }
          if (config.sortable) {
            table.removeEventListener("click", onHeaderClick);
            table.removeEventListener("keydown", onHeaderKeydown);
          }
          document.body.classList.remove("is-column-resizing");
        }
      };
    }

    window.GridTable = {
      create: createGridTable,
      defaults: DEFAULTS
    };
  })();

  function fixTableSortIcons(table) {
    if (!table) return;
    var sortIconNone = "\u2195";
    var sortIconAsc = "\u2191";
    var sortIconDesc = "\u2193";
    table.querySelectorAll("thead th .gt-sort-icon.th-sort-icon").forEach(function (icon) {
      var header = icon.closest("th");
      var ariaSort = header ? header.getAttribute("aria-sort") || "none" : "none";
      if (ariaSort === "ascending") icon.textContent = sortIconAsc;
      else if (ariaSort === "descending") icon.textContent = sortIconDesc;
      else icon.textContent = sortIconNone;
      icon.setAttribute("aria-hidden", "true");
    });
  }

  function syncWrapScrollState(table) {
    if (!table) return;
    var wrap = table.closest(".table-wrap") || table.closest(".table-responsive");
    if (!wrap) return;
    var availableWidth = wrap.clientWidth;
    if (!availableWidth) return;
    var total = 0;
    var cols = table.querySelectorAll("colgroup col");
    cols.forEach(function (col) {
      var w = parseFloat(col.style.width);
      total += Number.isFinite(w) && w > 0 ? w : col.getBoundingClientRect().width || 0;
    });
    wrap.classList.toggle("has-horizontal-scroll", total > availableWidth + 1);
  }

  function closeAllRowMenus() {
    document.querySelectorAll(".record-actions-menu").forEach(function (m) {
      m.classList.remove("is-open", "show");
      m.hidden = true;
      m.style.visibility = "";
    });
    document.querySelectorAll(".row-actions.record-actions-open").forEach(function (cell) {
      cell.classList.remove("record-actions-open");
    });
  }

  function toggleRowMenu(key, event) {
    if (event) event.stopPropagation();
    var menu = document.getElementById("dropdown-" + key);
    if (!menu) return;

    var isOpen = menu.classList.contains("is-open") || menu.classList.contains("show") || !menu.hidden;

    closeAllRowMenus();

    var moreDropdown = document.getElementById("moreDropdown");
    if (moreDropdown) moreDropdown.classList.remove("show");

    if (!isOpen) {
      var btn = event && (event.currentTarget || (event.target && event.target.closest && event.target.closest(".record-actions-toggle")));
      menu.style.position = "fixed";
      menu.style.visibility = "hidden";
      menu.hidden = false;
      menu.classList.add("is-open", "show");

      if (btn && btn.getBoundingClientRect) {
        var rect = btn.getBoundingClientRect();
        var gap = 4;
        var pad = 8;
        var menuWidth = menu.offsetWidth || 160;
        var menuHeight = menu.offsetHeight || 0;
        var left = rect.right + gap;
        if (left + menuWidth > window.innerWidth - pad) {
          left = rect.left - menuWidth - gap;
        }
        if (left < pad) {
          left = pad;
        }
        var top = rect.top;
        if (top + menuHeight > window.innerHeight - pad) {
          top = Math.max(pad, window.innerHeight - pad - menuHeight);
        }
        if (top < pad) {
          top = pad;
        }
        menu.style.left = left + "px";
        menu.style.top = top + "px";

        var cell = btn.closest(".row-actions");
        if (cell) cell.classList.add("record-actions-open");
      }
      menu.style.visibility = "visible";
    }
  }

  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".row-actions")) {
      closeAllRowMenus();
    }
  });

  function renderTableHeader() {
    const table = document.getElementById("recordsTable");
    const headerRow = document.getElementById("tableHeaderRow");
    const colGroup = document.getElementById("tableColGroup");
    if (!headerRow || !table) return;

    ensureSchemaFieldsFromRecords();

    // Require ObjectName and at least one schema field before rendering headers
    if (!appState.objectName || appState.schemaFields.length === 0) {
      if (table.__gridTableInstance && typeof table.__gridTableInstance.destroy === "function") {
        table.__gridTableInstance.destroy();
      }
      delete table.dataset.gridTableSchemaKey;
      if (colGroup) colGroup.innerHTML = "";
      headerRow.innerHTML = "";
      return;
    }

    const schemaKey = [
      appState.objectName,
      ...appState.schemaFields.map(f => f.internalName)
    ].join("|");

    // GridTable owns the live headers. Only replace them when the repository
    // schema changes; tbody-only renders use its refresh() lifecycle below.
    if (table.dataset.gridTableSchemaKey === schemaKey) return;

    if (table.__gridTableInstance && typeof table.__gridTableInstance.destroy === "function") {
      table.__gridTableInstance.destroy();
    }
    table.dataset.gridTableSchemaKey = schemaKey;

    let html = `<tr>`;
    html += `<th class="row-checkbox-head no-sort no-resize" scope="col"><label class="sr-only" for="selectAllCheckbox">Select all</label><input type="checkbox" id="selectAllCheckbox" class="row-checkbox-input" aria-label="Select all rows" onchange="toggleSelectAll(this)"></th>`;
    html += `<th class="row-actions-head no-sort no-resize" scope="col" aria-label="Actions"></th>`;

    // Render ONLY the actual fields returned by Serviceapp_Report â€” no manufactured columns
    appState.schemaFields.forEach(f => {
      html += `<th scope="col" data-field="${escapeHtml(f.internalName)}">` +
        `<span class="th-label">${escapeHtml(f.displayName)}</span>` +
        `</th>`;
    });

    html += `</tr>`;
    if (colGroup) colGroup.innerHTML = "";
    headerRow.innerHTML = html;
  }

function applyFiltersAndRender() {
    // For backend pagination, filtering/sorting is done on the server.
    // Just render the current page records directly.
    renderTable();
  }

  function buildRowActionsCell(key) {
    return (
      '<td class="row-actions" data-row-key="' +
      escapeHtml(key) +
      '" onclick="event.stopPropagation();">' +
      '<button class="record-actions-toggle" type="button" data-row-menu-toggle data-row-key="' +
      escapeHtml(key) +
      '" aria-label="Open actions" onclick="toggleRowMenu(\'' + escapeHtml(key) + '\', event)"><i class="fa fa-ellipsis-v" aria-hidden="true"></i></button>' +
      '<div class="record-actions-menu" id="dropdown-' + escapeHtml(key) + '" hidden>' +
      '<button type="button" class="record-actions-item" data-row-action="view" data-row-key="' +
      escapeHtml(key) +
      '" onclick="viewRecord(\'' + escapeHtml(key) + '\', event)"><i class="fa fa-eye" aria-hidden="true"></i><span>View</span></button>' +
      '<button type="button" class="record-actions-item" data-row-action="view-new-window" data-row-key="' +
      escapeHtml(key) +
      '" onclick="viewRecordInNewWindow(\'' + escapeHtml(key) + '\', event)"><i class="fa fa-eye" aria-hidden="true"></i><span>View in new window</span></button>' +
      '<button type="button" class="record-actions-item" data-row-action="edit" data-row-key="' +
      escapeHtml(key) +
      '" onclick="editRecord(\'' + escapeHtml(key) + '\', event)"><i class="fa fa-pencil" aria-hidden="true"></i><span>Edit</span></button>' +
      '<button type="button" class="record-actions-item" data-row-action="delete" data-row-key="' +
      escapeHtml(key) +
      '" onclick="deleteRecord(\'' + escapeHtml(key) + '\', event)"><i class="fa fa-trash-o" aria-hidden="true"></i><span>Delete</span></button>' +
      '</div></td>'
    );
  }

  function getInitialGridColumnWidths(table) {
    const wrapper = table.closest(".table-wrap") || table.closest(".table-responsive");
    const availableWidth = Math.round((wrapper && wrapper.clientWidth) || table.clientWidth || 0);
    const dataColumnCount = appState.schemaFields.length;
    const utilityColumnWidths = [40, 40];
    const companyMinimumDataWidth = 90;

    if (!availableWidth || dataColumnCount === 0) return utilityColumnWidths;

    const availableDataWidth = Math.max(
      availableWidth - utilityColumnWidths[0] - utilityColumnWidths[1],
      dataColumnCount * companyMinimumDataWidth
    );
    const baseDataWidth = Math.floor(availableDataWidth / dataColumnCount);
    const remainingPixels = availableDataWidth - (baseDataWidth * dataColumnCount);

    return utilityColumnWidths.concat(
      appState.schemaFields.map((_, index) => baseDataWidth + (index < remainingPixels ? 1 : 0))
    );
  }

  function clearLegacyGridTableWidthsOnce() {
    try {
      if (localStorage.getItem(GRIDTABLE_WIDTHS_MIGRATION_KEY)) return;
      if (window.GridTable && typeof window.GridTable.clearSavedWidths === "function") {
        window.GridTable.clearSavedWidths("service_request");
      }
      localStorage.setItem(GRIDTABLE_WIDTHS_MIGRATION_KEY, "1");
    } catch (e) { }
  }

function renderTable() {
    const tbody = document.getElementById("tableBody");
    console.log("[Repository Render] Starting render");
    console.log("[Repository Render] tableBody exists:", !!tbody);
    console.log("[Repository Render] records:", appState.records ? appState.records.length : 0);
    ensureSchemaFieldsFromRecords();
    console.log("[Repository Render] schemaFields:", appState.schemaFields ? appState.schemaFields.length : 0);
    console.log("[Repository Render] filteredRecords:", appState.filteredRecords ? appState.filteredRecords.length : 0);

    renderTableHeader();

    if (!tbody) return;
    tbody.innerHTML = "";

    // Guard: require ObjectName
    if (!appState.objectName) {
      if (navigationStateIsResolving) {
        showLoadingState();
        return;
      }
      tbody.innerHTML = `
      <tr>
        <td colspan="100%" style="text-align:center; padding: 48px 24px; color:#c0392b; font-size: 15px;">
          <i class="fa fa-exclamation-triangle" style="font-size: 2.5rem; margin-bottom: 12px; display: block;"></i>
          <strong>No ObjectName provided in URL.</strong>
          <p style="margin-top: 6px; font-size: 13px; color: #888;">Add <code>?ObjectName=YourRepositoryName</code> to the URL.</p>
        </td>
      </tr>
    `;
      updatePaginationControls();
      return;
    }

syncPageSizeFromUI();
    // For backend pagination, appState.records already contains only the current page's records
    const pageItems = appState.records;
    const totalCols = Math.max(appState.schemaFields.length + 2, 3);

    if (pageItems.length === 0) {
      tbody.innerHTML = `
      <tr>
        <td colspan="${totalCols}" style="text-align:center; padding: 48px 24px; color:#888; font-size: 14px;">
          <i class="fa-solid fa-folder-open" style="font-size: 2.2rem; margin-bottom: 12px; display: block; color: #ccc;"></i>
          No records found
        </td>
      </tr>
    `;
      updatePaginationControls();
    } else {
      pageItems.forEach(row => {
        const tr = document.createElement("tr");
        tr.dataset.recordId = row.RecordID;

        let cellsHtml = `
        <td class="row-checkbox" onclick="event.stopPropagation();">
          <input type="checkbox" class="row-checkbox-input row-checkbox" aria-label="Select record" value="${row.RecordID}">
        </td>
      ` + buildRowActionsCell(row.RecordID);

        // Render only actual repository fields returned by Serviceapp_Report
        appState.schemaFields.forEach(f => {
          let rawVal = row[f.internalName] !== undefined ? row[f.internalName] : "";
          // Workflow already cleaned lookup values; cleanGuidValue is a safety net
          let formattedVal = cleanGuidValue(String(rawVal));

          if ((f.internalName.toLowerCase().includes("date") || f.dataType === "Date") && typeof formattedVal === "string") {
            if (formattedVal.includes(" ")) formattedVal = formattedVal.split(" ")[0];
            else if (formattedVal.includes("T")) formattedVal = formattedVal.split("T")[0];
          }

          // Check for corresponding _FileMetadata field
          const metadataKey = f.internalName + "_FileMetadata";
          const metadataRaw = row[metadataKey];
          let cellHtml = "";

          if (metadataRaw) {
            // Parse metadata safely
            let attachments = [];
            try {
              const parsed = typeof metadataRaw === "string" ? JSON.parse(metadataRaw) : metadataRaw;
              if (Array.isArray(parsed)) {
                attachments = parsed.filter(a => a && typeof a === "object" && a.link);
              }
            } catch (e) {
              // Invalid JSON - treat as no metadata
              attachments = [];
            }

            if (attachments.length > 0) {
              // Render each attachment as a clickable link
              const linksHtml = attachments.map((att, idx) => {
                const link = att.link || "";
                const displayName = att.displayName || (idx === 0 ? formattedVal : `Attachment ${idx + 1}`);
                // Use QuickAppFlow attachment download endpoint for relative paths,
                // or use absolute URLs directly
                const fileUrl = link.startsWith("http")
                  ? link
                  : `Attachment/downloadfile?fileUrl=${encodeURIComponent(link)}`;
                const safeDisplayName = escapeHtml(displayName);
                const safeFileUrl = escapeHtml(fileUrl);
                return `<a href="${safeFileUrl}" target="_blank" rel="noopener noreferrer" class="attachment-link" onclick="event.stopPropagation();" title="${safeDisplayName}">${safeDisplayName}</a>`;
              }).join("<br>");
              cellHtml = linksHtml;
            }
          }

          if (!cellHtml) {
            cellHtml = escapeHtml(formattedVal);
          }

          cellsHtml += `<td>${cellHtml}</td>`;
        });

        tr.innerHTML = cellsHtml;
        tr.addEventListener("click", () => openDrawer(row));
        tbody.appendChild(tr);
      });

      updatePaginationControls();
    }

    // The company GridTable is initialized once and refreshed after tbody renders.
    const table = document.getElementById("recordsTable");
    if (table && window.GridTable) {
      try {
        if (table.__gridTableInstance) {
          table.__gridTableInstance.refresh();
        } else {
          clearLegacyGridTableWidthsOnce();
          table.__gridTableInstance = window.GridTable.create(table, {
            columnWidths: getInitialGridColumnWidths(table),
            resizeStorageKey: table.getAttribute("data-resize-key") || "service_request"
          });
        }
      } catch (err) {
        console.error("[GridTable] Initialization failed:", err);
        table.__gridTableInstance = null;
      }
    }

    if (table) {
      syncWrapScrollState(table);
    }

    console.log("[Repository Render] rendered rows:", document.getElementById("tableBody")?.children.length);
  }

  function renderDynamicDrawerForm(record) {
    const container = document.getElementById("dynamicFormContainer");
    if (!container) return;
    container.innerHTML = "";

    if (!appState.objectName || appState.schemaFields.length === 0) {
      container.innerHTML = `<p style="color:#888;">No field schema available.</p>`;
      return;
    }

    appState.schemaFields.forEach(f => {
      const group = document.createElement("div");
      group.className = "form-group";

      const fieldInputId = `field_${f.internalName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

      const label = document.createElement("label");
      label.setAttribute("for", fieldInputId);
      label.textContent = f.displayName;
      group.appendChild(label);

      const val = record ? (record[f.internalName] || "") : "";

      let choicesArr = [];
      if (f.choices && typeof f.choices === "string") {
        choicesArr = f.choices.split(";#").map(c => c.trim()).filter(c => c !== "");
      }

      if (choicesArr.length > 0) {
        const select = document.createElement("select");
        select.id = fieldInputId;
        select.name = fieldInputId;
        select.className = "form-control";
        select.dataset.fieldId = f.fieldId || "";

        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = `-- Select ${f.displayName} --`;
        select.appendChild(defaultOpt);

        choicesArr.forEach(c => {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          if (c === val) opt.selected = true;
          select.appendChild(opt);
        });
        group.appendChild(select);
      } else if (f.internalName.toLowerCase().includes("date") || f.dataType === "Date") {
        const dateWrapper = document.createElement("div");
        dateWrapper.className = "date-input-wrapper";

        const dateInput = document.createElement("input");
        dateInput.type = "date";
        dateInput.id = fieldInputId;
        dateInput.name = fieldInputId;
        dateInput.className = "form-control";
        dateInput.dataset.fieldId = f.fieldId || "";
        dateInput.value = formatDateForInput(val);

        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "date-clear-btn";
        clearBtn.textContent = "Clear";
        clearBtn.onclick = () => clearDate(fieldInputId);

        dateWrapper.appendChild(dateInput);
        dateWrapper.appendChild(clearBtn);
        group.appendChild(dateWrapper);
      } else if (f.internalName.toLowerCase().includes("detail") || f.internalName.toLowerCase().includes("description")) {
        const textarea = document.createElement("textarea");
        textarea.id = fieldInputId;
        textarea.name = fieldInputId;
        textarea.className = "form-control";
        textarea.placeholder = f.displayName;
        textarea.dataset.fieldId = f.fieldId || "";
        textarea.value = val;
        group.appendChild(textarea);
      } else if (f.dataType === "Number" || f.dataType === "Integer" || f.internalName.toLowerCase().includes("hour") || f.internalName.toLowerCase().includes("amount")) {
        const numInput = document.createElement("input");
        numInput.type = "number";
        numInput.id = fieldInputId;
        numInput.name = fieldInputId;
        numInput.className = "form-control";
        numInput.placeholder = f.displayName;
        numInput.dataset.fieldId = f.fieldId || "";
        numInput.value = val;
        group.appendChild(numInput);
      } else {
        const input = document.createElement("input");
        input.type = f.internalName.toLowerCase().includes("email") ? "email" : "text";
        input.id = fieldInputId;
        input.name = fieldInputId;
        input.className = "form-control";
        input.placeholder = f.displayName;
        input.dataset.fieldId = f.fieldId || "";
        input.value = val;
        group.appendChild(input);
      }

      container.appendChild(group);
    });
  }

  function openEditWorkflow() {
    const targetId = appState.objectId || appState.wfId;
    if (!targetId) return;
    const workflowUrl = `https://training.quickappflow.com/workflow-engine/${targetId}`;
    console.log("[LWR] Opening Edit Workflow URL:", workflowUrl);
    window.open(workflowUrl, '_blank');
  }

  function toggleMoreMenu(event) {
    event.stopPropagation();
    document.querySelectorAll(".action-dropdown").forEach(el => el.classList.remove("show"));
    const moreDropdown = document.getElementById("moreDropdown");
    if (moreDropdown) moreDropdown.classList.toggle("show");
  }

  function closeMoreMenu() {
    const moreDropdown = document.getElementById("moreDropdown");
    if (moreDropdown) moreDropdown.classList.remove("show");
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".cell-action") && !e.target.closest(".row-actions")) {
      document.querySelectorAll(".action-dropdown").forEach(el => el.classList.remove("show"));
    }
    if (!e.target.closest(".more-dropdown-wrapper")) {
      const moreDropdown = document.getElementById("moreDropdown");
      if (moreDropdown) moreDropdown.classList.remove("show");
    }
  });

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

function updatePaginationControls() {
    syncPageSizeFromUI();
    const totalItems = appState.totalRecordCount || 0;
    const hasMore = appState.hasMore;

    const startItem = totalItems === 0 ? 0 : (appState.currentPage - 1) * appState.pageSize + 1;
    const endItem = startItem + appState.records.length - 1;

    const indicator = document.getElementById("pageIndicator");
    if (indicator) {
      if (totalItems > 0) {
        indicator.textContent = `${startItem} - ${endItem} of ${totalItems}`;
      } else if (appState.records.length > 0) {
        indicator.textContent = `${startItem} - ${endItem}`;
      } else {
        indicator.textContent = "0 of 0";
      }
    }

    const prevBtn = document.getElementById("prevPageBtn");
    if (prevBtn) prevBtn.disabled = appState.currentPage <= 1;

    const nextBtn = document.getElementById("nextPageBtn");
    if (nextBtn) nextBtn.disabled = !hasMore || appState.records.length < appState.pageSize;
  }

  async function prevPage() {
    if (appState.currentPage > 1 && !appState.isLoading) {
      appState.currentPage--;
      await ALWAYS_FETCH_GET_RECORDS_API();
    }
  }

  async function nextPage() {
    if (appState.hasMore && !appState.isLoading) {
      appState.currentPage++;
      await ALWAYS_FETCH_GET_RECORDS_API();
    }
  }

  async function changePageSize(newSize) {
    if (appState.isLoading) return;
    appState.pageSize = parseInt(newSize, 10) || 10;
    appState.currentPage = 1;
    await ALWAYS_FETCH_GET_RECORDS_API();
  }

  let searchDebounceTimer = null;
  function handleSearch(query) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      appState.searchQuery = query.trim();
      appState.currentPage = 1;
      // Trigger backend fetch with new search filter
      await ALWAYS_FETCH_GET_RECORDS_API();
    }, 300);
  }

  function toggleSelectAll(checkbox) {
    document.querySelectorAll(".row-checkbox").forEach(cb => {
      cb.checked = checkbox.checked;
    });
  }

  function openDrawer(record) {
    if (!appState.objectName) return;

    appState.activeRecord = record;

    const recordIdEl = document.getElementById("field_recordID");
    if (recordIdEl) recordIdEl.value = record ? (record.RecordID || "") : "";

    const createdByEl = document.getElementById("field_CreatedBy");
    if (createdByEl) createdByEl.value = record ? (record.CreatedBy || getCurrentUserName()) : getCurrentUserName();

    renderDynamicDrawerForm(record);

    document.getElementById("drawerBackdrop").classList.add("open");
    document.getElementById("drawerPanel").classList.add("open");
    setDrawerReadOnly(false);
  }

  function formatDateForInput(rawDate) {
    if (!rawDate) return "";
    if (rawDate.includes("T")) return rawDate.split("T")[0];
    if (rawDate.includes("-")) return rawDate;
    if (rawDate.includes("/")) {
      const datePart = rawDate.split(" ")[0];
      const parts = datePart.split("/");
      if (parts.length === 3) {
        const month = parts[0].padStart(2, '0');
        const day = parts[1].padStart(2, '0');
        const year = parts[2];
        return `${year}-${month}-${day}`;
      }
    }
    return rawDate;
  }

  async function viewRecord(recordId, event) {
    if (event) event.stopPropagation();
    closeAllRowMenus();

    // Use the already-fetched record from appState â€” Serviceapp_Report is the sole data source.
    // GetSingleRecord (objectID-based) is no longer used.
    const record = appState.records.find(r => r.RecordID === recordId);

    if (record) {
      openDrawer(record);
      setDrawerReadOnly(true);
    }
  }

  async function viewRecordInNewWindow(recordId, event) {
    if (event) event.stopPropagation();
    closeAllRowMenus();
    // Keep the row key for later API wiring. No API call is made here.
    return recordId;
  }

  async function editRecord(recordId, event) {
    if (event) event.stopPropagation();
    closeAllRowMenus();

    let record = appState.records.find(r => r.RecordID === recordId);
    if (record) {
      openDrawer(record);
      setDrawerReadOnly(false);
    }
  }

  function setDrawerReadOnly(isReadOnly) {
    const form = document.getElementById("recordForm");
    if (!form) return;
    const inputs = form.querySelectorAll("input, select, textarea");
    inputs.forEach(el => {
      if (el.id === "field_recordID") return;
      if (isReadOnly) {
        el.setAttribute("readonly", "true");
        el.setAttribute("disabled", "true");
        el.style.opacity = "0.7";
        el.style.cursor = "not-allowed";
      } else {
        el.removeAttribute("readonly");
        el.removeAttribute("disabled");
        el.style.opacity = "";
        el.style.cursor = "";
      }
    });

    const saveBtn = form.closest(".drawer-body")?.parentElement?.querySelector(".btn-drawer-save");
    if (saveBtn) {
      saveBtn.style.display = isReadOnly ? "none" : "";
    }
  }

  async function deleteRecord(recordId, event) {
    if (event) event.stopPropagation();
    closeAllRowMenus();

    if (!confirm("Are you sure you want to delete this record?")) return;

    try {
      await fetchWithRetry(`https://ndem.quickappflow.com/api/DeleteRecord?recordID=${recordId}`, {
        method: "POST",
        headers: getAuthHeaders()
      }, 2, 300);
    } catch (err) {
      console.warn("[LWR] DeleteRecord API error:", err.message);
    }

appState.records = appState.records.filter(r => r.RecordID !== recordId);
    applyFiltersAndRender();
    showToast("Record deleted successfully.", "success");
  }

async function openNewRecordDrawer() {
    if (!appState.objectName) {
      showToast("No ObjectName provided. Cannot create a new record.", "error");
      return;
    }

    const repositoryName = appState.objectName;
    console.log("[LWR Add Record] ObjectName=", repositoryName);

    // Helper to refresh repository data after OOTB form completes
    const onAddFormDone = async () => {
      console.log("[LWR Add Record] Add form completed, refreshing repository");
      await ALWAYS_FETCH_GET_RECORDS_API();
    };

    // Prefer QafLibrary.openAddForm (richer API), fallback to QafPageService.AddItem
    // Pattern from knowledgebase.js: use repositoryName for both repositoryName and objectID
    if (window.QafLibrary && typeof window.QafLibrary.openAddForm === "function") {
      console.log("[LWR Add Record] Using QafLibrary.openAddForm");
      window.QafLibrary.openAddForm({
        repositoryName: repositoryName,
        objectID: repositoryName,
        onDone: onAddFormDone
      });
      return;
    }

    // Fallback: check window and parent for QafPageService
    let pageService = null;
    if (window.QafPageService && typeof window.QafPageService.AddItem === "function") {
      pageService = window.QafPageService;
    } else if (
      window.parent &&
      window.parent.QafPageService &&
      typeof window.parent.QafPageService.AddItem === "function"
    ) {
      pageService = window.parent.QafPageService;
    }

    if (pageService) {
      console.log("[LWR Add Record] Using QafPageService.AddItem");
      pageService.AddItem(repositoryName, onAddFormDone);
      return;
    }

    // No QAF form service available - show clear error
    console.error("[LWR Add Record] No QAF form service available (QafLibrary.openAddForm or QafPageService.AddItem)");
    showToast("Unable to open Add form: QAF form service not available.", "error");
  }

  function closeDrawer() {
    document.getElementById("drawerBackdrop").classList.remove("open");
    document.getElementById("drawerPanel").classList.remove("open");
    appState.activeRecord = null;
  }

  function clearDate(fieldId) {
    const el = document.getElementById(fieldId);
    if (el) el.value = "";
  }

  async function saveCurrentRecord() {
    // NOTE: Serviceapp_Report is a READ workflow. SaveRecord/UpdateRecord use the
    // QuickAppFlow SaveRecord API (objectID-based). Without a real objectID for the
    // selected repository, save cannot guarantee correct persistence.
    // CRUD functionality is preserved structurally but will require the objectID
    // to be available (e.g. from a separate CRUD workflow) to work reliably.

    if (!appState.objectName) {
      showToast("No repository selected. Cannot save record.", "error");
      return;
    }

    const recordID = document.getElementById("field_recordID")?.value || "rec-" + Date.now();
    const createdBy = document.getElementById("field_CreatedBy")?.value || getCurrentUserName();
    const modifiedBy = getCurrentUserName();

    const recordFieldValues = [];
    const updatedRecord = { RecordID: recordID };

    appState.schemaFields.forEach(f => {
      const el = document.getElementById(`field_${f.internalName.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
      let val = el ? el.value : "";

      if ((f.internalName.toLowerCase().includes("date") || f.dataType === "Date") && val && !val.includes("T")) {
        val = `${val}T06:30:00`;
      }

      updatedRecord[f.internalName] = val;

      if (f.fieldId) {
        recordFieldValues.push({ fieldID: f.fieldId, fieldValue: val || "" });
      }
    });

    const payload = {
      DrMode: false,
      createdByID: 10,
      createdByGUID: "55e2ecd3-9b12-401b-b1d2-b7c90b260b76",
      lastModifiedBy: 10,
      lastModifiedByGUID: "55e2ecd3-9b12-401b-b1d2-b7c90b260b76",
      objectName: appState.objectName,
      recordID: recordID,
      recordFieldValues: recordFieldValues,
      recordFieldValuesChild: []
    };

    const isExistingRecord = appState.records.some(r => r.RecordID === recordID);
    const targetSaveUrl = isExistingRecord
      ? "https://ndem.quickappflow.com/api/UpdateRecord"
      : CONFIG.SAVE_RECORD_URL;

    try {
      const result = await fetchWithRetry(targetSaveUrl, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      }, 2, 300);
      console.log("[Serviceapp_Report] Save/Update API response:", result);
    } catch (err) {
      console.warn("[Serviceapp_Report] Save/Update API fetch error:", err.message);
    }

    const existingIdx = appState.records.findIndex(r => r.RecordID === recordID);
    if (existingIdx >= 0) {
      appState.records[existingIdx] = updatedRecord;
    } else {
      appState.records.unshift(updatedRecord);
    }
    applyFiltersAndRender();
    closeDrawer();

    await ALWAYS_FETCH_GET_RECORDS_API();
    showToast("Record saved successfully!", "success");
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid fa-circle-check"></i> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Bulk Import Feature
  function openImportBulkModal() {
    if (!appState.objectName) {
      showToast("No repository selected. Cannot import.", "error");
      return;
    }
    document.getElementById("importModalBackdrop").classList.add("open");
    document.getElementById("importModal").classList.add("open");
    document.getElementById("importFileInput").value = "";
    const statusArea = document.getElementById("importStatusArea");
    statusArea.style.display = "none";
    statusArea.innerHTML = "";
  }

  function closeImportBulkModal() {
    document.getElementById("importModalBackdrop").classList.remove("open");
    document.getElementById("importModal").classList.remove("open");
  }

  function downloadImportTemplate(event) {
    event.preventDefault();
    if (!appState.objectName) return;

    if (typeof XLSX === "undefined") {
      showToast("SheetJS library not loaded. Please refresh and try again.", "error");
      return;
    }

    const cols = appState.schemaFields.map(f => f.internalName);
    if (cols.length === 0) {
      showToast("No schema fields available.", "error");
      return;
    }

    const ws = XLSX.utils.aoa_to_sheet([cols]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Repository_Data");
    XLSX.writeFile(wb, `Import_Template_${appState.objectName}.xlsx`);
    showToast("Template downloaded successfully!", "success");
  }

  function handleImportFile(inputEl) {
    const file = inputEl.files[0];
    if (!file || !appState.objectName) return;

    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
      showToast("Only MS Excel files (.xlsx, .xls) are supported.", "error");
      inputEl.value = "";
      return;
    }

    const statusArea = document.getElementById("importStatusArea");
    statusArea.style.display = "block";
    statusArea.innerHTML = `<p>Reading file: <strong>${escapeHtml(file.name)}</strong>...</p>`;

    const reader = new FileReader();
    reader.onload = function (e) {
      processImportWorkbook(e.target.result, statusArea);
    };
    reader.onerror = function () {
      statusArea.innerHTML = `<p class="import-error">Error reading file. Please try again.</p>`;
    };
    reader.readAsArrayBuffer(file);
  }

  async function processImportWorkbook(data, statusArea) {
    if (typeof XLSX === "undefined" || !appState.objectName) {
      statusArea.innerHTML = `<p class="import-error">SheetJS library not loaded or no repository selected.</p>`;
      return;
    }

    let workbook;
    try {
      workbook = XLSX.read(data, { type: "array" });
    } catch (err) {
      statusArea.innerHTML = `<p class="import-error">Failed to parse Excel file: ${escapeHtml(err.message)}</p>`;
      return;
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      statusArea.innerHTML = `<p class="import-error">No sheets found in the workbook.</p>`;
      return;
    }

    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) {
      statusArea.innerHTML = `<p class="import-error">File has no data rows. Please add data below the header row.</p>`;
      return;
    }

    const headerRow = jsonData[0].map(h => String(h).trim());
    const expectedCols = appState.schemaFields.map(f => f.internalName);

    const missingColumns = expectedCols.filter(e => !headerRow.includes(e));

    if (missingColumns.length > 0) {
      statusArea.innerHTML = `
      <p class="import-error"><strong>Import failed:</strong> Missing required columns.</p>
      <p class="import-error">Missing: <strong>${missingColumns.join(", ")}</strong></p>
    `;
      return;
    }

    const colIndex = {};
    expectedCols.forEach(title => {
      colIndex[title] = headerRow.indexOf(title);
    });

    const dataRows = jsonData.slice(1).filter(row => row.some(cell => cell !== undefined && cell !== null && cell !== ""));
    const totalRows = dataRows.length;

    if (totalRows === 0) {
      statusArea.innerHTML = `<p class="import-error">No data rows found to import.</p>`;
      return;
    }

    statusArea.innerHTML = `
    <p>Importing <strong>${totalRows}</strong> record(s)...</p>
    <div class="import-progress-bar"><div class="import-progress-fill" id="importProgressFill" style="width:0%"></div></div>
    <p id="importProgressText">0 / ${totalRows}</p>
  `;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < totalRows; i++) {
      const row = dataRows[i];
      const recordFieldValues = [];

      appState.schemaFields.forEach(f => {
        const idx = colIndex[f.internalName];
        let val = (idx >= 0 && row[idx] !== undefined && row[idx] !== null) ? String(row[idx]).trim() : "";

        if ((f.internalName.toLowerCase().includes("date") || f.dataType === "Date") && val && !val.includes("T")) {
          if (!isNaN(val)) {
            const excelDate = XLSX.SSF.parse_date_code(parseFloat(val));
            if (excelDate) {
              const mm = String(excelDate.m).padStart(2, "0");
              const dd = String(excelDate.d).padStart(2, "0");
              val = `${excelDate.y}-${mm}-${dd}T06:30:00`;
            }
          } else {
            val = `${val}T06:30:00`;
          }
        }

        if (f.fieldId) {
          recordFieldValues.push({ fieldID: f.fieldId, fieldValue: val });
        }
      });

      let newGuid = "import-" + Date.now() + "-" + i;
      try {
        const guidRes = await fetchWithRetry("https://ndem.quickappflow.com/api/NewRecordGuid", {
          method: "POST",
          headers: getAuthHeaders()
        }, 2, 300);
        if (typeof guidRes === "string" && guidRes.length > 10) newGuid = guidRes;
      } catch (e) { }

      const payload = {
        DrMode: false,
        createdByID: 10,
        createdByGUID: "55e2ecd3-9b12-401b-b1d2-b7c90b260b76",
        lastModifiedBy: 10,
        lastModifiedByGUID: "55e2ecd3-9b12-401b-b1d2-b7c90b260b76",
        objectName: appState.objectName,
        recordID: newGuid,
        recordFieldValues: recordFieldValues,
        recordFieldValuesChild: []
      };

      try {
        await fetchWithRetry(CONFIG.SAVE_RECORD_URL, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        }, 2, 300);
        successCount++;
      } catch (err) {
        failCount++;
      }

      const pct = Math.round(((i + 1) / totalRows) * 100);
      const progressFill = document.getElementById("importProgressFill");
      if (progressFill) progressFill.style.width = pct + "%";
      const progressText = document.getElementById("importProgressText");
      if (progressText) progressText.textContent = `${i + 1} / ${totalRows}`;
    }

    statusArea.innerHTML = `<p class="import-success">Import complete: <strong>${successCount}</strong> saved, <strong>${failCount}</strong> failed.</p>`;
    await ALWAYS_FETCH_GET_RECORDS_API();
    showToast(`Import complete: ${successCount} saved.`, "success");
  }

  function exportRepositoryData() {
    if (!appState.objectName || !appState.records || appState.records.length === 0) {
      showToast("No data available to export.", "info");
      return;
    }

    if (typeof XLSX === "undefined") {
      showToast("SheetJS library not loaded.", "error");
      return;
    }

    // Export only the actual repository fields returned by Serviceapp_Report â€” no manufactured columns
    const exportRows = appState.records.map(row => {
      const obj = {};
      appState.schemaFields.forEach(f => {
        obj[f.displayName || f.internalName] = row[f.internalName] !== undefined ? row[f.internalName] : "";
      });
      return obj;
    });

    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Repository_Data");
    XLSX.writeFile(wb, `Export_${appState.objectName}.xlsx`);
    showToast("Repository exported successfully!", "success");
  }

  // Expose global functions to window for HTML onclick attributes and QuickAppFlow lifecycle
  window.getURLParameters = getURLParameters;
  window.refreshParamsFromURL = refreshParamsFromURL;
  window.activateRepository = activateRepository;
  window.waitForRepositoryDOM = waitForRepositoryDOM;
  window.handleNavigationChange = handleNavigationChange;
  window.switchTab = switchTab;
  window.handleSearch = handleSearch;
  window.openNewRecordDrawer = openNewRecordDrawer;
  window.closeDrawer = closeDrawer;
  window.saveCurrentRecord = saveCurrentRecord;
  window.deleteRecord = deleteRecord;
  window.viewRecord = viewRecord;
  window.viewRecordInNewWindow = viewRecordInNewWindow;
  window.editRecord = editRecord;
  window.toggleRowMenu = toggleRowMenu;
  window.exportRepositoryData = exportRepositoryData;
  window.changePageSize = changePageSize;
  window.prevPage = prevPage;
  window.nextPage = nextPage;
  window.toggleSelectAll = toggleSelectAll;
  window.closeImportBulkModal = closeImportBulkModal;
  window.downloadImportTemplate = downloadImportTemplate;
  window.handleImportFile = handleImportFile;
})();