(function () {
    "use strict";
  
    // Shared defaults for sortable/resizable grid tables.
    const DEFAULTS = {
      sortable: true,
      resizable: true,
      minWidth: 90,
      maxWidth: 520,
      // Page-declared layout, all index-aligned with the header cells.
      // columnWidths gives each column its default width; columnMinWidths and
      // columnMaxWidths override minWidth / maxWidth for individual columns.
      // Supplying these is how a page states its layout -- it should never
      // write to <colgroup> itself.
      columnWidths: null,
      columnMinWidths: null,
      columnMaxWidths: null,
      resizeStorageKey: "",
      headerSelector: "thead th",
      bodySelector: "tbody",
      sortableHeaderClass: "gt-sortable",
      activeSortClass: "gt-sorted",
      sortIconClass: "gt-sort-icon",
      resizerClass: "gt-col-resizer",
      noSortClass: "no-sort",
      noResizeClass: "no-resize"
    };
  function initTableLibrary() {
    const tableLibrary = require("gridtable.js");
    tableLibrary.initAll(utlity );
    return tableLibrary;
  }
    function ensureGridTableStyles() {
      if (document.getElementById("gt-runtime-styles")) return;
      var style = document.createElement("style");
      style.id = "gt-runtime-styles";
      style.textContent =
        "table thead th{position:relative;}" +
        "table[data-gt-resizable]{table-layout:fixed!important;width:max-content;min-width:0!important;}" +
        "table[data-gt-resizable] th,table[data-gt-resizable] td{min-width:0!important;box-sizing:border-box;}" +
        ".gt-col-resizer{position:absolute;top:0;right:-3px;width:6px;height:100%;cursor:col-resize;user-select:none;touch-action:none;}" +
        ".gt-col-resizer::after{content:\"\";position:absolute;top:4px;bottom:4px;left:50%;width:2px;transform:translateX(-50%);border-radius:1px;background:transparent;transition:background .12s ease;}" +
        ".gt-col-resizer:hover::after,.gt-col-resizer.is-resizing::after{background:var(--color-border-strong,#94a3b8);}" +
        // Thinner than the 2px separator pipe, but centred on the same column
        // boundary via translateX(-50%) so it stays aligned with it rather
        // than sitting half a pixel to its right.
        ".gt-resize-line{position:fixed;top:0;width:1px;transform:translateX(-50%);z-index:9999;background:var(--color-border-strong,#94a3b8);pointer-events:none;}" +
        "body.is-column-resizing{cursor:col-resize!important;}" +
        "body.is-column-resizing *{cursor:col-resize!important;}";
      document.head.appendChild(style);
    }
  
    function resolveResizeStorageKey(table, options) {
      var explicit = String((options && options.resizeStorageKey) || "").trim();
      if (explicit) return "gridtable:widths:" + explicit;
      var tableKey = String((table && table.getAttribute("data-resize-key")) || "").trim();
      if (tableKey) return "gridtable:widths:" + tableKey;
      return "";
    }
  
    // Saved widths are trusted only when they describe exactly this table's
    // column count. A stale entry from a different layout is discarded outright
    // rather than partially applied, which used to leave some columns unpinned.
    function readSavedWidths(storageKey, expectedCount) {
      if (!storageKey || !window.localStorage) return null;
      try {
        var raw = window.localStorage.getItem(storageKey);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        if (Number.isFinite(expectedCount) && parsed.length !== expectedCount) {
          window.localStorage.removeItem(storageKey);
          return null;
        }
        var widths = parsed.map(function (value) {
          var width = Number(value);
          return Number.isFinite(width) && width >= 0 ? Math.round(width) : null;
        });
        return widths.some(function (width) { return width != null; }) ? widths : null;
      } catch (_) {
        return null;
      }
    }

    function saveWidths(table, storageKey) {
      if (!storageKey || !window.localStorage || !table) return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(getColumnWidths(table)));
      } catch (_) {}
    }

    // Discard a table's remembered widths so it falls back to its declared
    // defaults on the next create(). Accepts the bare key or the full one.
    function clearSavedWidths(storageKey) {
      var key = String(storageKey || "").trim();
      if (!key || !window.localStorage) return;
      if (key.indexOf("gridtable:widths:") !== 0) key = "gridtable:widths:" + key;
      try {
        window.localStorage.removeItem(key);
      } catch (_) {}
    }
  
    function isNumeric(value) {
      const text = String(value == null ? "" : value).trim().replace(/,/g, "");
      return /^-?\d+(\.\d+)?$/.test(text);
    }
  
    // Compare values as numbers when possible, otherwise natural string compare.
    function compareValues(a, b) {
      const aText = String(a == null ? "" : a).trim();
      const bText = String(b == null ? "" : b).trim();
      if (isNumeric(aText) && isNumeric(bText)) return Number(aText.replace(/,/g, "")) - Number(bText.replace(/,/g, ""));
      return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: "base" });
    }
  
    // Ensure column widths are controlled through a colgroup.
    function ensureColGroup(table, visibleColumns) {
      let colGroup = table.querySelector("colgroup");
      if (!colGroup) {
        colGroup = document.createElement("colgroup");
        table.insertBefore(colGroup, table.firstChild);
      }
  
      const currentCols = Array.from(colGroup.querySelectorAll("col"));
      if (currentCols.length !== visibleColumns) {
        colGroup.innerHTML = "";
        for (let i = 0; i < visibleColumns; i += 1) colGroup.appendChild(document.createElement("col"));
      }
      return colGroup;
    }
  
    // Heuristic width based on visible row text lengths.
    function estimateColumnWidth(table, columnIndex, minWidth, maxWidth) {
      const rows = Array.from(table.querySelectorAll("tr")).slice(0, 40);
      let maxChars = 8;
      rows.forEach((row) => {
        const cell = row.children[columnIndex];
        const text = cell ? String(cell.textContent || "").trim() : "";
        maxChars = Math.max(maxChars, text.length);
      });
      const width = Math.round(maxChars * 8 + 32);
      return Math.max(minWidth, Math.min(maxWidth, width));
    }
  
    /* ==================================================================
     * COLUMN WIDTH ENGINE
     * ------------------------------------------------------------------
     * All column sizing lives here, so every grid behaves identically and no
     * page needs to touch <colgroup> itself.
     *
     * The invariants that make a drag well-behaved:
     *
     *  1. Every column always carries an explicit px width on its <col>, and
     *     the table's own width is the exact sum of them, under
     *     table-layout:fixed. A column can then only change when its own entry
     *     changes -- the browser is never left free to redistribute space into
     *     its neighbours.
     *
     *  2. Dragging column i rewrites widths[i] and nothing else. Columns to its
     *     LEFT keep their width and position. Columns to its RIGHT keep their
     *     width and simply shift, because the table total grew or shrank by the
     *     same delta.
     *
     *  3. min/max clamping applies ONLY to the column being dragged. Widths the
     *     page declares, and no-resize columns, are honoured exactly as given --
     *     so a 36px checkbox column is never inflated to the 90px default
     *     minimum, which is what used to make untouched columns jump on render.
     * ================================================================== */

    function isNoResizeHeader(header, options) {
      return Boolean(header && header.classList.contains(options.noResizeClass));
    }

    function pickPerColumn(list, index) {
      if (!Array.isArray(list)) return NaN;
      const value = Number(list[index]);
      return Number.isFinite(value) ? value : NaN;
    }

    function getColumnMinWidth(index, options, header) {
      // A no-resize column is page-owned; the global minimum must not touch it.
      if (isNoResizeHeader(header, options)) return 0;
      const perColumn = pickPerColumn(options.columnMinWidths, index);
      return Number.isFinite(perColumn) && perColumn >= 0 ? perColumn : options.minWidth;
    }

    function getColumnMaxWidth(index, options, header) {
      if (isNoResizeHeader(header, options)) return Infinity;
      const perColumn = pickPerColumn(options.columnMaxWidths, index);
      return Number.isFinite(perColumn) && perColumn > 0 ? perColumn : options.maxWidth;
    }

    function clampColumnWidth(width, index, options, header) {
      return Math.max(
        getColumnMinWidth(index, options, header),
        Math.min(getColumnMaxWidth(index, options, header), width)
      );
    }

    // Measure one column. The header is consulted before the <col> element
    // because <col>.getBoundingClientRect() is unreliable across engines, and a
    // 0 here used to leave the column with no explicit width at all.
    function measureColumnWidth(table, columnIndex, options) {
      const cols = table.querySelectorAll("colgroup col");
      const col = cols[columnIndex];
      if (col) {
        const styled = parseFloat(col.style.width);
        if (Number.isFinite(styled) && styled > 0) return styled;
      }

      const headers = table.querySelectorAll(options.headerSelector || DEFAULTS.headerSelector);
      const header = headers[columnIndex];
      if (header) {
        const headerWidth = header.getBoundingClientRect().width;
        if (Number.isFinite(headerWidth) && headerWidth > 1) return headerWidth;
      }

      if (col) {
        const rendered = col.getBoundingClientRect().width;
        if (Number.isFinite(rendered) && rendered > 1) return rendered;
      }

      return 0;
    }

    // Current width of every column, as integers.
    function getColumnWidths(table) {
      if (!table) return [];
      return Array.from(table.querySelectorAll("colgroup col")).map(function (col) {
        const styled = parseFloat(col.style.width);
        if (Number.isFinite(styled) && styled >= 0) return Math.round(styled);
        return Math.round(col.getBoundingClientRect().width || 0);
      });
    }

    // Write EVERY column width, then size the table to their exact sum.
    // Nothing is skipped: a <col> left unwritten is precisely what allows a
    // neighbouring column to absorb the dragged column's delta.
    function applyColumnWidths(table, widths) {
      if (!table || !Array.isArray(widths)) return;
      const cols = table.querySelectorAll("colgroup col");
      let total = 0;
      for (let i = 0; i < cols.length; i += 1) {
        let width = Number(widths[i]);
        if (!Number.isFinite(width) || width < 0) width = 0;
        width = Math.round(width);
        cols[i].style.width = `${width}px`;
        total += width;
      }
      if (total > 0) {
        table.style.width = `${total}px`;
        table.style.minWidth = "";
      }
    }

    // Width each column should start at, in priority order:
    // saved (the user's own drag) -> page-declared default -> measured -> estimated.
    function resolveInitialWidths(table, headers, options, storageKey) {
      const saved = readSavedWidths(storageKey, headers.length);
      const declared = Array.isArray(options.columnWidths) ? options.columnWidths : null;

      return headers.map(function (header, index) {
        const declaredWidth = pickPerColumn(declared, index);

        // A no-resize column can never have been dragged, so a saved value must
        // not apply to it -- and neither must the global minimum.
        if (isNoResizeHeader(header, options)) {
          if (Number.isFinite(declaredWidth) && declaredWidth >= 0) return Math.round(declaredWidth);
          return Math.max(0, Math.round(measureColumnWidth(table, index, options)));
        }

        const savedWidth = saved ? Number(saved[index]) : NaN;
        if (Number.isFinite(savedWidth) && savedWidth > 0) {
          return Math.round(clampColumnWidth(savedWidth, index, options, header));
        }

        // A declared default is the page stating its own layout, so it is used
        // verbatim rather than being squeezed into min/max.
        if (Number.isFinite(declaredWidth) && declaredWidth > 0) return Math.round(declaredWidth);

        const measured = measureColumnWidth(table, index, options);
        if (measured > 0) return Math.round(clampColumnWidth(measured, index, options, header));

        return Math.round(
          estimateColumnWidth(
            table,
            index,
            getColumnMinWidth(index, options, header),
            getColumnMaxWidth(index, options, header)
          )
        );
      });
    }
  
    function getCellText(row, index) {
      const cell = row.children[index];
      return cell ? String(cell.textContent || "").trim() : "";
    }
  
    // Attach click handlers and maintain tri-state sorting.
    function setupSorting(instance) {
      const { table, options, state } = instance;
      const headers = Array.from(table.querySelectorAll(options.headerSelector));
      headers.forEach((header, index) => {
        if (header.classList.contains(options.noSortClass)) return;
        header.classList.add(options.sortableHeaderClass);
        header.classList.add("is-sortable");
        header.dataset.gtSortIndex = String(index);
        header.setAttribute("aria-sort", "none");
        if (!header.querySelector(`.${options.sortIconClass}`)) {
          const icon = document.createElement("span");
          icon.className = `${options.sortIconClass} th-sort-icon`;
          icon.textContent = "\u2195";
          icon.setAttribute("aria-hidden", "true");
          header.appendChild(icon);
        }
      });
  
      state.onHeaderClick = function (event) {
        const header = event.target.closest(`${options.headerSelector}.${options.sortableHeaderClass}`);
        if (!header || header.querySelector(`.${options.resizerClass}`)?.contains(event.target)) return;
        const sortIndex = Number(header.dataset.gtSortIndex);
        if (!Number.isFinite(sortIndex)) return;
  
        if (state.sort.column !== sortIndex) state.sort = { column: sortIndex, direction: "asc" };
        else if (state.sort.direction === "asc") state.sort.direction = "desc";
        else if (state.sort.direction === "desc") state.sort = { column: null, direction: null };
        else state.sort = { column: sortIndex, direction: "asc" };
  
        sortTableRows(instance);
        updateSortIndicators(instance);
      };
  
      table.addEventListener("click", state.onHeaderClick);
    }
  
    // Sort tbody rows in place, preserving original order for ties/reset.
    function sortTableRows(instance) {
      const { table, options, state } = instance;
      const body = table.querySelector(options.bodySelector);
      if (!body) return;
      const rows = Array.from(body.querySelectorAll("tr"));
  
      if (state.sort.column == null || !state.sort.direction) {
        rows
          .slice()
          .sort((a, b) => Number(a.dataset.gtOriginalIndex || 0) - Number(b.dataset.gtOriginalIndex || 0))
          .forEach((row) => body.appendChild(row));
        return;
      }
  
      const factor = state.sort.direction === "desc" ? -1 : 1;
      rows
        .slice()
        .sort((a, b) => {
          const compared = compareValues(getCellText(a, state.sort.column), getCellText(b, state.sort.column));
          if (compared !== 0) return compared * factor;
          return Number(a.dataset.gtOriginalIndex || 0) - Number(b.dataset.gtOriginalIndex || 0);
        })
        .forEach((row) => body.appendChild(row));
    }
  
    // Keep sort icons/header state in sync with active sorting.
    function updateSortIndicators(instance) {
      const { table, options, state } = instance;
      const headers = Array.from(table.querySelectorAll(options.headerSelector));
      headers.forEach((header, index) => {
        const icon = header.querySelector(`.${options.sortIconClass}`);
        if (!icon) return;
        if (state.sort.column !== index || !state.sort.direction) {
          header.classList.remove(options.activeSortClass);
          header.classList.remove("is-sorted");
          header.setAttribute("aria-sort", "none");
          icon.textContent = "\u2195";
        } else {
          header.classList.add(options.activeSortClass);
          header.classList.add("is-sorted");
          header.setAttribute("aria-sort", state.sort.direction === "asc" ? "ascending" : "descending");
          icon.textContent = state.sort.direction === "asc" ? "\u2191" : "\u2193";
        }
      });
    }
  
    // Attach drag handles and apply constrained column resizing.
    function setupResizing(instance) {
      const { table, options, state } = instance;
      const headers = Array.from(table.querySelectorAll(options.headerSelector));
      ensureColGroup(table, headers.length);
      const storageKey = resolveResizeStorageKey(table, options);
      state.storageKey = storageKey;
      state.headers = headers;

      headers.forEach((header, index) => {
        if (isNoResizeHeader(header, options)) {
          // Drop a handle left behind if the column became no-resize later.
          const stale = header.querySelector(`.${options.resizerClass}`);
          if (stale) stale.remove();
          return;
        }

        let handle = header.querySelector(`.${options.resizerClass}`);
        if (!handle) {
          handle = document.createElement("div");
          handle.className = options.resizerClass;
          handle.setAttribute("role", "separator");
          handle.setAttribute("aria-label", `Resize ${String(header.textContent || "").trim()} column`);
          header.appendChild(handle);
        }
        handle.dataset.gtColIndex = String(index);
      });

      applyColumnWidths(table, resolveInitialWidths(table, headers, options, storageKey));

      state.onMouseDown = function (event) {
        const handle = event.target.closest(`.${options.resizerClass}`);
        if (!handle) return;
        event.preventDefault();
        const index = Number(handle.dataset.gtColIndex);
        if (!Number.isFinite(index)) return;

        const targetHeader = headers[index];

        // Snapshot every column once, at drag start. Each mousemove rewrites
        // only entry [index] of THIS snapshot and re-applies the whole set, so
        // the pointer delta is always measured from the original width and no
        // other column can drift - not even by accumulated rounding.
        const lockedWidths = getColumnWidths(table);
        let startWidth = lockedWidths[index];
        if (!Number.isFinite(startWidth) || startWidth <= 0) {
          startWidth =
            Math.round(measureColumnWidth(table, index, options)) ||
            getColumnMinWidth(index, options, targetHeader) ||
            options.minWidth;
          lockedWidths[index] = startWidth;
        }
        const startX = event.clientX;

        // Minimal active-resize indicator: a thin vertical line that tracks
        // the actual (clamped) column boundary -- not the raw pointer -- so
        // it never drifts past the column's min/max width and always lines
        // up with the header's own edge (reusable across grids).
        handle.classList.add("is-resizing");
        const resizeLine = document.createElement("div");
        resizeLine.className = "gt-resize-line";
        const tableRect = table.getBoundingClientRect();
        const startBoundaryRect = targetHeader
          ? targetHeader.getBoundingClientRect()
          : { right: event.clientX };
        // Not rounded: the pipe sits at the header's exact (often fractional)
        // right edge, so rounding here would knock the line off it by up to 1px.
        resizeLine.style.left = `${startBoundaryRect.right}px`;
        resizeLine.style.top = `${tableRect.top}px`;
        resizeLine.style.height = `${tableRect.height}px`;
        document.body.appendChild(resizeLine);

        const onMouseMove = (moveEvent) => {
          const nextWidths = lockedWidths.slice();
          nextWidths[index] = clampColumnWidth(
            startWidth + (moveEvent.clientX - startX),
            index,
            options,
            targetHeader
          );
          applyColumnWidths(table, nextWidths);
          const liveRect = table.getBoundingClientRect();
          const boundaryRect = targetHeader ? targetHeader.getBoundingClientRect() : null;
          resizeLine.style.left = `${boundaryRect ? boundaryRect.right : moveEvent.clientX}px`;
          resizeLine.style.top = `${liveRect.top}px`;
          resizeLine.style.height = `${liveRect.height}px`;
        };
        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          document.body.classList.remove("is-column-resizing");
          handle.classList.remove("is-resizing");
          if (resizeLine.parentNode) resizeLine.parentNode.removeChild(resizeLine);
          saveWidths(table, storageKey);
        };

        document.body.classList.add("is-column-resizing");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      };

      table.addEventListener("mousedown", state.onMouseDown);
    }
  
    // Persist initial row order to support reset-to-original sorting.
    function rememberOriginalOrder(table, bodySelector) {
      const rows = Array.from(table.querySelectorAll(`${bodySelector} tr`));
      rows.forEach((row, index) => {
        if (!row.dataset.gtOriginalIndex) row.dataset.gtOriginalIndex = String(index);
      });
    }
  
    // Create one GridTable instance per table element.
    function create(table, userOptions) {
      if (!table) return null;
      if (table.__gridTableInstance) return table.__gridTableInstance;
      ensureGridTableStyles();
      const options = Object.assign({}, DEFAULTS, userOptions || {});
      const state = {
        sort: { column: null, direction: null },
        onHeaderClick: null,
        onMouseDown: null
      };
  
      const instance = {
        table,
        options,
        state,
        refresh: function () {
          rememberOriginalOrder(table, options.bodySelector);
          if (options.sortable) updateSortIndicators(instance);
          // Re-assert the column widths after a body re-render. Pages rebuild
          // <tbody> constantly; without this the colgroup could be left
          // describing a stale column count.
          if (options.resizable) instance.syncWidths();
        },
        // Recompute and re-apply every column width using the same priority
        // order as setup (saved -> declared -> measured). Public so a page can
        // re-assert widths after it swaps the table contents.
        syncWidths: function () {
          const liveHeaders = Array.from(table.querySelectorAll(options.headerSelector));
          if (!liveHeaders.length) return;
          state.headers = liveHeaders;
          ensureColGroup(table, liveHeaders.length);
          applyColumnWidths(
            table,
            resolveInitialWidths(table, liveHeaders, options, state.storageKey)
          );
        },
        destroy: function () {
          if (state.onHeaderClick) table.removeEventListener("click", state.onHeaderClick);
          if (state.onMouseDown) table.removeEventListener("mousedown", state.onMouseDown);
          table.removeAttribute("data-gt-resizable");
          table.__gridTableInstance = null;
        }
      };
  
      rememberOriginalOrder(table, options.bodySelector);
      if (options.sortable) setupSorting(instance);
      if (options.resizable) {
        table.setAttribute("data-gt-resizable", "true");
        setupResizing(instance);
      }
      table.__gridTableInstance = instance;
      return instance;
    }
  
    // Initialize GridTable for all matched tables.
    function initAll(selector, options) {
      return Array.from(document.querySelectorAll(selector || "table")).map((table) => create(table, options));
    }
  
    window.GridTable = {
      create,
      initAll,
      // Exposed so any page can drive column sizing through this one engine
      // rather than writing to <colgroup> itself (which is what used to let
      // two sizing systems fight over the same table).
      getColumnWidths,
      applyColumnWidths,
      clearSavedWidths
    };
  })();
  
  (function () {
    "use strict";
  
    // Normalize nullable values to trimmed strings.
    function toSafeString(value) {
      return String(value == null ? "" : value).trim();
    }
  
    // Access QAF data service from current or parent frame.
    function getQafService() {
      return window.QafService || (window.parent && window.parent.QafService) || null;
    }
  
    // Access QAF page/form service from current or parent frame.
    function getQafPageService() {
      return window.QafPageService || (window.parent && window.parent.QafPageService) || null;
    }
  
    // Build a deduplicated set of repository targets for service calls.
    function asRepositoryTargets(repositoryName, objectID) {
      var out = [];
      var seen = {};
      function add(value) {
        var key = toSafeString(value);
        if (!key) return;
        var check = key.toLowerCase();
        if (seen[check]) return;
        seen[check] = true;
        out.push(key);
      }
      add(repositoryName);
      add(objectID);
      add(toSafeString(repositoryName).replace(/\s+/g, "_"));
      add(toSafeString(repositoryName).replace(/\s+/g, ""));
      return out;
    }
  
    // Try service methods/signatures in sequence until one succeeds.
    function callQafPageServiceMethod(methods, argSets) {
      var service = getQafPageService();
      if (!service) return false;
      for (var i = 0; i < methods.length; i += 1) {
        var methodName = methods[i];
        var fn = service && service[methodName];
        if (typeof fn !== "function") continue;
        for (var a = 0; a < argSets.length; a += 1) {
          try {
            fn.apply(service, argSets[a]);
            return true;
          } catch (_) {}
        }
      }
      return false;
    }
  
    // Normalize different QAF payload shapes into a row array.
    function extractRowsFromQafResponse(payload) {
      if (Array.isArray(payload)) return payload;
      if (!payload || typeof payload !== "object") return [];
      if (Array.isArray(payload.Items)) return payload.Items;
      if (Array.isArray(payload.Data)) return payload.Data;
      if (Array.isArray(payload.Value)) return payload.Value;
      if (payload.value && Array.isArray(payload.value)) return payload.value;
      if (payload.data && Array.isArray(payload.data)) return payload.data;
      if (payload.result && Array.isArray(payload.result)) return payload.result;
      if (payload.rows && Array.isArray(payload.rows)) return payload.rows;
      if (payload.items && Array.isArray(payload.items)) return payload.items;
      return [];
    }
  
    function flattenRecordRow(row) {
      if (!row || typeof row !== "object") return {};
      var out = Object.assign({}, row);
  
      function toTitleWords(text) {
        return String(text || "")
          .split(" ")
          .filter(Boolean)
          .map(function (part) {
            return part.charAt(0).toUpperCase() + part.slice(1);
          })
          .join(" ");
      }
  
      function buildKeyAliases(key) {
        var raw = toSafeString(key);
        if (!raw) return [];
        var spaced = raw
          .replace(/_/g, " ")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/\s+/g, " ")
          .trim();
        var compact = spaced.replace(/\s+/g, "");
        var underscored = spaced.replace(/\s+/g, "_");
        var aliases = [
          raw,
          spaced,
          compact,
          underscored,
          compact.toLowerCase(),
          underscored.toLowerCase(),
          toTitleWords(spaced)
        ];
        var seen = {};
        var outAliases = [];
        for (var i = 0; i < aliases.length; i += 1) {
          var v = toSafeString(aliases[i]);
          if (!v) continue;
          var check = v.toLowerCase();
          if (seen[check]) continue;
          seen[check] = true;
          outAliases.push(v);
        }
        return outAliases;
      }
  
      function assignIfEmpty(targetKey, nextValue) {
        if (!targetKey) return;
        if (!Object.prototype.hasOwnProperty.call(out, targetKey) || out[targetKey] == null || out[targetKey] === "") {
          out[targetKey] = nextValue;
        }
      }
  
      var rfv = Array.isArray(row.RecordFieldValues) ? row.RecordFieldValues : [];
      for (var i = 0; i < rfv.length; i += 1) {
        var item = rfv[i] || {};
        var value = item.UGFieldValue;
        if (value == null) value = item.UGFfieldValue;
        if (value == null) value = item.FieldValue;
        if (value == null) value = item.Value;
        if (value == null) value = item.fieldValue;
        if (value == null) value = item.ugFieldValue;
        if (value == null) value = item.value;
        var finalValue = value == null ? "" : value;
  
        // Keep row access resilient by writing value to all known field key aliases.
        var keyCandidates = [
          item.FieldInternalName,
          item.dsNm,
          item.dn,
          item.FieldName,
          item.DisplayName,
          item.name
        ]
          .map(toSafeString)
          .filter(Boolean);
  
        for (var k = 0; k < keyCandidates.length; k += 1) {
          var aliases = buildKeyAliases(keyCandidates[k]);
          for (var a = 0; a < aliases.length; a += 1) {
            assignIfEmpty(aliases[a], finalValue);
          }
        }
      }
      // Normalize lookup-formatted values so tables don't show "id;#Label".
      Object.keys(out).forEach(function (k) {
        var current = out[k];
        if (typeof current === "string" && current.indexOf(";#") >= 0) {
          out[k] = lookupToText(current, current);
        }
      });
      return out;
    }
  
    function normalizeRowsForTable(payload) {
      var rows = extractRowsFromQafResponse(payload);
      if (!Array.isArray(rows) || !rows.length) return [];
      return rows.map(flattenRecordRow);
    }
  
    function getApiBaseUrl() {
      var envBase = toSafeString(window.APP_ENV && window.APP_ENV.API_BASE_URL);
      if (envBase) return envBase.replace(/\/+$/, "");
      // Match page-level default used in working screens (asset-details/requisition).
      return "https://ndem.quickappflow.com";
    }
  
    function getAuthHeadersFromStorage() {
      function tryParseJson(input) {
        try {
          return JSON.parse(input);
        } catch (_) {
          return null;
        }
      }
      var parsed = tryParseJson((window.localStorage && window.localStorage.getItem("user_key")) || "");
      var parsedValue =
        parsed && typeof parsed.value === "string"
          ? tryParseJson(parsed.value)
          : parsed && parsed.value;
      var payload =
        (parsedValue && typeof parsedValue === "object" && parsedValue) ||
        (parsed && typeof parsed === "object" && parsed) ||
        {};
      return {
        "Content-Type": "application/json",
        employeeguid: payload.employeeguid || payload.EmployeeGUID || "",
        hrzemail: payload.hrzemail || payload.Email || "",
        hrzempid: payload.hrzempid || payload.EmployeeID || "",
        lngs: payload.lngs || "Asia/Kolkata"
      };
    }
  
    function withBaseUrl(path) {
      var base = getApiBaseUrl();
      if (!base) return path;
      return base + path;
    }
  
    // Convert route/path to absolute app URL.
    function toAbsolutePageUrl(path) {
      var raw = toSafeString(path);
      if (!raw) return "";
      if (/^https?:\/\//i.test(raw)) return raw;
      if (raw.charAt(0) === "/") return window.location.origin + raw;
      return window.location.origin + "/" + raw;
    }
  
    // Build a URL with query params, ignoring null/empty values.
    function buildPageUrl(options) {
      var config = options || {};
      var path = toSafeString(config.path || config.url || config.route || config.pagePath);
      if (!path) throw new Error("buildPageUrl requires path/url/route/pagePath.");
      var finalUrl = new URL(toAbsolutePageUrl(path));
      var params = config.params && typeof config.params === "object" ? config.params : {};
      Object.keys(params).forEach(function (key) {
        var value = params[key];
        if (value == null) return;
        if (typeof value === "string" && value.trim() === "") return;
        finalUrl.searchParams.set(key, String(value));
      });
      return finalUrl.toString();
    }
  
    // Navigate to a specific page using a route + query param map.
    function navigateToPage(options) {
      var config = options || {};
      var href = buildPageUrl(config);
      var openInNewTab = Boolean(config.newTab || config.openInNewTab);
      if (openInNewTab) {
        window.open(href, "_blank");
        return href;
      }
      if (Boolean(config.replace)) window.location.replace(href);
      else window.location.assign(href);
      return href;
    }
  
    function createObjectNameCandidates(config) {
      var fromConfig = [];
      if (Array.isArray(config.objectNames)) fromConfig = config.objectNames.slice();
      var first = toSafeString(config.objectName || config.repositoryName || config.repository);
      var candidates = fromConfig.concat([
        first,
        first.replace(/\s+/g, "_"),
        first.replace(/_/g, " "),
        first.replace(/\s+/g, ""),
        "Asset Requisition",
        "AssetRequisition",
        "Asset_Requisition"
      ]);
      var out = [];
      var seen = {};
      for (var i = 0; i < candidates.length; i += 1) {
        var name = toSafeString(candidates[i]);
        if (!name) continue;
        var key = name.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        out.push(name);
      }
      return out;
    }
  
    async function fetchRecordsForFieldsViaApi(config, objectName) {
      var fieldList = toSafeString(config.fieldList || config.fields || "*");
      var pageSize = Number(config.pageSize || 0) || 0;
      var currentPage = Number(config.currentPage || 1) || 1;
      var filterCondition = toSafeString(config.filterCondition || config.filter || "");
      var sortBy = toSafeString(config.sortBy || "");
      var isAscending = typeof config.isAscending === "boolean" ? config.isAscending : true;
      var params = new URLSearchParams({
        objectName: objectName,
        fieldList: fieldList,
        orderBy: sortBy,
        whereClause: filterCondition,
        pageSize: String(pageSize || 10),
        pageNumber: String(currentPage || 1),
        isAscending: isAscending ? "true" : "false"
      });
      var url = withBaseUrl("/api/GetRecordsForFields?" + params.toString());
      var response = await window.fetch(url, {
        method: "POST",
        headers: getAuthHeadersFromStorage(),
        // Some environments reject empty POST bodies on this endpoint.
        body: "{}"
      });
      if (!response || !response.ok) {
        throw new Error("REST fetch failed (" + (response ? response.status : "unknown") + ")");
      }
      var text = await response.text();
      var payload = null;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        payload = text;
      }
      if (payload === false) {
        throw new Error("REST fetch returned boolean false payload");
      }
      return payload;
    }
  
    function normalizeSystemKey(value) {
      return String(value || "")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
    }
  
    function hasBusinessFields(rows) {
      var list = Array.isArray(rows) ? rows : [];
      if (!list.length) return false;
      var systemOnlyKeys = {
        id: true,
        objectid: true,
        recordid: true,
        parentrecordid: true,
        createdbyguid: true,
        createdbyname: true,
        createddate: true,
        lastmodifieddate: true,
        modifieddate: true,
        createdby: true,
        modifiedby: true,
        instanceid: true
      };
      for (var i = 0; i < list.length; i += 1) {
        var row = list[i];
        if (!row || typeof row !== "object") continue;
        var keys = Object.keys(row);
        for (var k = 0; k < keys.length; k += 1) {
          var key = normalizeSystemKey(keys[k]);
          if (!key) continue;
          if (!systemOnlyKeys[key]) return true;
        }
      }
      return false;
    }
  
    function extractFirstRow(payload) {
      if (!payload || typeof payload !== "object") return null;
      if (Array.isArray(payload)) return payload[0] || null;
      var rows = extractRowsFromQafResponse(payload);
      if (rows.length) return rows[0];
      var nested = payload.data || payload.Data || payload.result || payload.Result || payload.object || payload.Object;
      if (Array.isArray(nested)) return nested[0] || null;
      if (nested && typeof nested === "object") return nested;
      return payload;
    }
  
    async function resolveViewIdForObjectName(objectName) {
      var candidates = [
        objectName,
        String(objectName || "").replace(/\s+/g, "_"),
        String(objectName || "").replace(/_/g, " "),
        String(objectName || "").replace(/\s+/g, "")
      ]
        .map(toSafeString)
        .filter(Boolean);
      var unique = [];
      var seen = {};
      for (var i = 0; i < candidates.length; i += 1) {
        var c = candidates[i];
        var lower = c.toLowerCase();
        if (seen[lower]) continue;
        seen[lower] = true;
        unique.push(c);
      }
  
      var objectId = "";
      for (var o = 0; o < unique.length; o += 1) {
        var enc = encodeURIComponent(unique[o]);
        var objectUrls = [
          withBaseUrl("/api/ObjectGet?option=object&objectID=" + enc),
          withBaseUrl("/api/ObjectGet?objectID=" + enc)
        ];
        for (var u = 0; u < objectUrls.length; u += 1) {
          try {
            var objectPayload = await fetchApiJson(objectUrls[u]);
            var row = extractFirstRow(objectPayload) || {};
            objectId = toSafeString(row.ObjectID || row.ObjectId || row.objectID || row.objectId);
            if (objectId) break;
          } catch (_) {}
        }
        if (objectId) break;
      }
      if (!objectId) return "";
  
      try {
        var viewPayload = await fetchApiJson(withBaseUrl("/api/ViewGet?objectID=" + encodeURIComponent(objectId)));
        var viewRow = extractFirstRow(viewPayload) || {};
        return toSafeString(viewRow.ViewID || viewRow.viewId || viewRow.ID || viewRow.Id);
      } catch (_) {
        return "";
      }
    }
  
    async function fetchRecordsViaViewApi(config, objectName) {
      var pageSize = Number(config.pageSize || 0) || 0;
      var currentPage = Number(config.currentPage || 1) || 1;
      var viewId = await resolveViewIdForObjectName(objectName);
      if (!viewId) {
        throw new Error("Could not resolve view ID for object: " + objectName);
      }
      var params = new URLSearchParams({
        viewID: viewId,
        pageSize: String(pageSize || 10),
        pageNumber: String(currentPage || 1)
      });
      return fetchApiJson(withBaseUrl("/api/GetRecords?" + params.toString()));
    }
  
    // Convert lookup/raw values to plain display text (e.g. "id;#Label" -> "Label").
    function lookupToText(value, fallback) {
      var defaultValue = fallback == null ? "" : String(fallback);
      if (value == null) return defaultValue;
      if (typeof value === "string") {
        var text = value.trim();
        if (!text) return defaultValue;
        if (text.indexOf(";#") >= 0) {
          var parts = text.split(";#");
          var labels = [];
          for (var i = 1; i < parts.length; i += 2) {
            var labelPart = String(parts[i] || "").trim();
            if (labelPart) labels.push(labelPart);
          }
          if (labels.length) return labels.join(", ");
          var firstLabel = parts.length > 1 ? String(parts[1] || "").trim() : "";
          return firstLabel || text || defaultValue;
        }
        return text;
      }
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (Array.isArray(value)) {
        var mapped = value
          .map(function (item) {
            return lookupToText(item, "");
          })
          .filter(function (item) {
            return String(item).trim() !== "";
          });
        return mapped.length ? mapped.join(", ") : defaultValue;
      }
      if (typeof value === "object") {
        var candidate =
          value.value ||
          value.label ||
          value.DisplayName ||
          value.Name ||
          value.Title ||
          value.text;
        if (candidate != null && String(candidate).trim() !== "") return lookupToText(candidate, defaultValue);
        var idCandidate = value.id || value.ID || value.RecordID;
        if (idCandidate != null && String(idCandidate).trim() !== "") return String(idCandidate).trim();
      }
      return defaultValue;
    }
  
    var __lookupFieldMetaCache = {};
    var __lookupLabelMapCache = {};
  
    function normalizeLooseKey(value) {
      return String(value || "")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
    }
  
    function parseLookupMeta(value) {
      var raw = toSafeString(value);
      if (!raw) return { id: "", name: "" };
      if (raw.indexOf(";#") >= 0) {
        var parts = raw.split(";#");
        return {
          id: toSafeString(parts[0]),
          name: toSafeString(parts[1] || parts[0]),
        };
      }
      return { id: raw, name: raw };
    }
  
    async function fetchApiJson(url) {
      var finalUrl = /^https?:\/\//i.test(String(url || "")) ? String(url) : withBaseUrl(String(url || ""));
      var response = await window.fetch(finalUrl, {
        method: "POST",
        headers: getAuthHeadersFromStorage(),
        body: "{}"
      });
      if (!response || !response.ok) throw new Error("Lookup request failed");
      var text = await response.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    }
  
    async function resolveObjectFieldMeta(options) {
      var config = options || {};
      var objectID = toSafeString(config.objectID || config.objectId);
      var objectName = toSafeString(config.objectName || config.repositoryName || config.repository);
      var cacheKey = normalizeLooseKey(objectID || objectName);
      if (!cacheKey) return [];
      if (Array.isArray(__lookupFieldMetaCache[cacheKey])) return __lookupFieldMetaCache[cacheKey];
  
      var candidates = [objectID, objectName, objectName.replace(/\s+/g, "_"), objectName.replace(/\s+/g, "")]
        .map(toSafeString)
        .filter(Boolean);
  
      for (var i = 0; i < candidates.length; i += 1) {
        try {
          var payload = await fetchApiJson(
            "/api/ObjectGet?option=object&objectID=" + encodeURIComponent(candidates[i])
          );
          var rows = extractRowsFromQafResponse(payload);
          var first = rows[0] || {};
          var fields = Array.isArray(first.Fields) ? first.Fields : [];
          if (fields.length) {
            __lookupFieldMetaCache[cacheKey] = fields;
            return fields;
          }
        } catch (_) {}
      }
  
      __lookupFieldMetaCache[cacheKey] = [];
      return [];
    }
  
    async function fetchLookupLabelMap(lookupObjectName, labelFieldName) {
      var objectName = toSafeString(lookupObjectName);
      if (!objectName) return {};
      var labelField = toSafeString(labelFieldName) || "Name";
      var cacheKey = normalizeLooseKey(objectName + "|" + labelField);
      if (__lookupLabelMapCache[cacheKey]) return __lookupLabelMapCache[cacheKey];
  
      var map = {};
      try {
        var fieldList = ["RecordID", "ID", labelField].join(",");
        var payload = await fetchApiJson(
          "/api/GetRecordsForFields?objectName=" +
            encodeURIComponent(objectName) +
            "&fieldList=" +
            encodeURIComponent(fieldList) +
            "&orderBy=&whereClause=&pageSize=100000&pageNumber=1&isAscending=true"
        );
        var rows = extractRowsFromQafResponse(payload);
        rows.forEach(function (row) {
          if (!row || typeof row !== "object") return;
          var id = toSafeString(row.RecordID || row.ID || row.Id || row.id);
          var label = lookupToText(row[labelField], "");
          if (!id || !label) return;
          map[id] = label;
        });
      } catch (_) {}
  
      __lookupLabelMapCache[cacheKey] = map;
      return map;
    }
  
    function buildColumnMatchKeys(column) {
      var key = toSafeString(column && (column.key || column.label));
      var label = toSafeString(column && (column.label || column.key));
      var keys = [];
      var seen = {};
      [key, label].forEach(function (k) {
        var n = normalizeLooseKey(k);
        if (!n || seen[n]) return;
        seen[n] = true;
        keys.push(n);
      });
      return keys;
    }
  
    async function enrichRowsWithLookupText(options) {
      var config = options || {};
      var rows = Array.isArray(config.rows) ? config.rows : [];
      if (!rows.length) return rows;
  
      var columns = Array.isArray(config.columns) ? config.columns : [];
      if (!columns.length) return rows;
  
      var fields = await resolveObjectFieldMeta({
        objectID: config.objectID,
        objectName: config.objectName,
        repositoryName: config.repositoryName,
        repository: config.repository,
      });
      if (!fields.length) return rows;
  
      var byKey = {};
      fields.forEach(function (field) {
        var internalName = toSafeString(field.InternalName);
        var displayName = toSafeString(field.DisplayName);
        [internalName, displayName].forEach(function (name) {
          var k = normalizeLooseKey(name);
          if (!k || byKey[k]) return;
          byKey[k] = field;
        });
      });
  
      var lookupPlans = [];
      for (var i = 0; i < columns.length; i += 1) {
        var column = columns[i];
        var matchKeys = buildColumnMatchKeys(column);
        var fieldMeta = null;
        for (var j = 0; j < matchKeys.length; j += 1) {
          if (byKey[matchKeys[j]]) {
            fieldMeta = byKey[matchKeys[j]];
            break;
          }
        }
        if (!fieldMeta) continue;
        var lkObj = parseLookupMeta(fieldMeta.LookupObject);
        if (!lkObj.name) continue;
        var lkLabel = parseLookupMeta(fieldMeta.LookupObjectField1);
        lookupPlans.push({
          column: column,
          lookupObject: lkObj.name,
          labelField: lkLabel.name || "Name",
        });
      }
  
      if (!lookupPlans.length) return rows;
  
      var maps = {};
      for (var p = 0; p < lookupPlans.length; p += 1) {
        var plan = lookupPlans[p];
        var mapKey = normalizeLooseKey(plan.lookupObject + "|" + plan.labelField);
        if (!maps[mapKey]) maps[mapKey] = await fetchLookupLabelMap(plan.lookupObject, plan.labelField);
        plan.map = maps[mapKey];
      }
  
      return rows.map(function (row) {
        if (!row || typeof row !== "object") return row;
        var next = Object.assign({}, row);
        lookupPlans.forEach(function (plan) {
          var key = toSafeString(plan.column && plan.column.key);
          var label = toSafeString(plan.column && plan.column.label);
          var targets = [key, label].filter(Boolean);
          targets.forEach(function (fieldKey) {
            if (!Object.prototype.hasOwnProperty.call(next, fieldKey)) return;
            var raw = next[fieldKey];
            if (raw == null) return;
            var asText = toSafeString(raw);
            if (!asText) return;
            if (asText.indexOf(";#") >= 0) {
              next[fieldKey] = lookupToText(asText, asText);
              return;
            }
            var fromMap = plan.map && plan.map[asText];
            if (fromMap) next[fieldKey] = fromMap;
          });
        });
        return next;
      });
    }
  
    // Reusable fetch wrapper for repository data queries.
    async function fetchRepositoryData(options) {
      var config = options || {};
      var objectName = toSafeString(config.objectName || config.repositoryName || config.repository);
      var fieldList = toSafeString(config.fieldList || config.fields || "*");
      var pageSize = Number(config.pageSize || 0) || 0;
      var currentPage = Number(config.currentPage || 1) || 1;
      var filterCondition = toSafeString(config.filterCondition || config.filter || "");
      var sortBy = toSafeString(config.sortBy || "");
      var isAscending = config.isAscending;
      if (typeof isAscending !== "boolean") isAscending = true;
  
      if (!objectName) throw new Error("objectName or repositoryName is required.");
  
      var response = null;
      var candidates = createObjectNameCandidates(config);
      var qafService = getQafService();
      if (qafService && typeof qafService.GetItems === "function") {
        response = await qafService.GetItems(
          objectName,
          fieldList,
          pageSize || undefined,
          currentPage || undefined,
          filterCondition || undefined,
          sortBy || undefined,
          isAscending
        );
  
        // If service payload is empty or only system/meta keys, fall back to REST object/view fetch.
        var serviceRows = extractRowsFromQafResponse(response);
        if (!serviceRows.length || !hasBusinessFields(serviceRows)) {
          var serviceFallbackError = null;
          for (var s = 0; s < candidates.length; s += 1) {
            var serviceCandidate = candidates[s];
            try {
              var viaFields = await fetchRecordsForFieldsViaApi(config, serviceCandidate);
              var viaFieldsRows = extractRowsFromQafResponse(viaFields);
              if (viaFieldsRows.length && hasBusinessFields(viaFieldsRows)) {
                response = viaFields;
                break;
              }
            } catch (error) {
              serviceFallbackError = error;
            }
            try {
              var viaViewFromService = await fetchRecordsViaViewApi(config, serviceCandidate);
              var viaViewRowsFromService = extractRowsFromQafResponse(viaViewFromService);
              if (viaViewRowsFromService.length) {
                response = viaViewFromService;
                break;
              }
            } catch (error) {
              serviceFallbackError = error;
            }
          }
          if (response == null && serviceFallbackError) {
            throw serviceFallbackError;
          }
        }
      } else {
        var lastError = null;
        for (var i = 0; i < candidates.length; i += 1) {
          try {
            var candidate = candidates[i];
            response = await fetchRecordsForFieldsViaApi(config, candidate);
            var candidateRows = extractRowsFromQafResponse(response);
            // If fields endpoint returns only system/meta columns, switch to view-based records.
            if (candidateRows.length && !hasBusinessFields(candidateRows)) {
              try {
                var viaView = await fetchRecordsViaViewApi(config, candidate);
                var viaViewRows = extractRowsFromQafResponse(viaView);
                if (viaViewRows.length) response = viaView;
              } catch (_) {}
            }
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (response == null) {
          for (var v = 0; v < candidates.length; v += 1) {
            try {
              response = await fetchRecordsViaViewApi(config, candidates[v]);
              var fallbackRows = extractRowsFromQafResponse(response);
              if (fallbackRows.length) break;
              response = null;
            } catch (error) {
              lastError = error;
            }
          }
        }
        if (response == null) {
          throw new Error(
            "QafService.GetItems is not available and REST fallback failed for repository/object candidates: " +
              candidates.join(", ") +
              (lastError ? ". Last error: " + (lastError.message || String(lastError)) : "")
          );
        }
      }
  
      return {
        raw: response,
        rows: normalizeRowsForTable(response)
      };
    }
  
    // Fetch one repository page in a normalized shape.
    async function fetchRepositoryPage(options) {
      var config = options || {};
      var pageSize = Number(config.pageSize || 10);
      if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 10;
      var currentPage = Number(config.currentPage || config.page || 1);
      if (!Number.isFinite(currentPage) || currentPage <= 0) currentPage = 1;
  
      var result = await fetchRepositoryData(
        Object.assign({}, config, {
          pageSize: pageSize,
          currentPage: currentPage
        })
      );
      var rows = Array.isArray(result && result.rows) ? result.rows : [];
      return {
        raw: result ? result.raw : null,
        rows: rows,
        rawCount: rows.length,
        page: currentPage,
        pageSize: pageSize,
        hasMore: rows.length >= pageSize
      };
    }
  
    // Fetch multiple pages and return table-ready merged rows.
    async function fetchRepositoryRowsForTable(options) {
      var config = options || {};
      var startPage = Number(config.startPage || 1);
      if (!Number.isFinite(startPage) || startPage <= 0) startPage = 1;
      var pageSize = Number(config.pageSize || 10);
      if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 10;
      var maxPages = Number(config.maxPages || 1);
      if (!Number.isFinite(maxPages) || maxPages <= 0) maxPages = 1;
      var dedupeBy = typeof config.dedupeBy === "function" ? config.dedupeBy : null;
      var sortNewestFirst = config.sortNewestFirst !== false;
      var sortDateKeys = Array.isArray(config.sortDateKeys) ? config.sortDateKeys : undefined;
      var onPage = typeof config.onPage === "function" ? config.onPage : null;
  
      var page = startPage;
      var loaded = 0;
      var rows = [];
      var lastRaw = null;
      var hasMore = true;
  
      while (hasMore && loaded < maxPages) {
        var pageResult = await fetchRepositoryPage(
          Object.assign({}, config, {
            currentPage: page,
            pageSize: pageSize
          })
        );
        var batch = Array.isArray(pageResult && pageResult.rows) ? pageResult.rows : [];
        rows = appendUniqueRows(rows, batch, dedupeBy || undefined);
        loaded += 1;
        lastRaw = pageResult ? pageResult.raw : null;
        hasMore = Boolean(pageResult && pageResult.hasMore) && batch.length > 0;
        if (onPage) {
          onPage({
            page: page,
            pageSize: pageSize,
            rawCount: batch.length,
            totalRows: rows.length,
            hasMore: hasMore
          });
        }
        page += 1;
      }
  
      if (sortNewestFirst) {
        rows = sortRowsNewestFirst(rows, { dateKeys: sortDateKeys });
      }
  
      return {
        raw: lastRaw,
        rows: rows,
        totalRows: rows.length,
        startPage: startPage,
        pagesLoaded: loaded,
        pageSize: pageSize,
        hasMore: hasMore
      };
    }
  
    // Fetch rows + repository view-ordered columns for dynamic tables.
    async function fetchRepositoryViewTableModel(options) {
      var config = options || {};
      var tableResult = await fetchRepositoryRowsForTable(
        Object.assign({ pageSize: 10, startPage: 1, maxPages: 1 }, config)
      );
      var rows = Array.isArray(tableResult && tableResult.rows) ? tableResult.rows : [];
  
      function parseViewFields(raw) {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === "string") {
          try {
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch (_) {
            return [];
          }
        }
        return [];
      }
  
      function fallbackInferColumns(rowsInput, opt) {
        var safeRows = Array.isArray(rowsInput) ? rowsInput : [];
        var cfg = opt || {};
        var exclude = {};
        (Array.isArray(cfg.excludeKeys) ? cfg.excludeKeys : []).forEach(function (k) {
          exclude[normalizeLooseKey(k)] = true;
        });
        var discovered = [];
        var seen = {};
        for (var r = 0; r < safeRows.length; r += 1) {
          var row = safeRows[r];
          if (!row || typeof row !== "object") continue;
          var keys = Object.keys(row);
          for (var i = 0; i < keys.length; i += 1) {
            var key = String(keys[i] || "").trim();
            var nk = normalizeLooseKey(key);
            if (!nk || exclude[nk] || seen[nk]) continue;
            seen[nk] = true;
            discovered.push(key);
          }
        }
        return discovered.map(function (k) {
          return { key: k, label: String(k) };
        });
      }
  
      var candidates = [];
      [config.objectID, config.objectId, config.objectName, config.repositoryName, config.repository]
        .map(toSafeString)
        .filter(Boolean)
        .forEach(function (c) {
          if (candidates.indexOf(c) === -1) candidates.push(c);
        });
      createObjectNameCandidates(config).forEach(function (c) {
        if (candidates.indexOf(c) === -1) candidates.push(c);
      });
  
      var viewFields = [];
      for (var i = 0; i < candidates.length; i += 1) {
        try {
          var payload = await fetchApiJson(
            withBaseUrl("/api/ViewGet?objectID=" + encodeURIComponent(candidates[i]))
          );
          var row = extractFirstRow(payload) || {};
          viewFields = parseViewFields(row.ViewFields || row.viewFields || row.Fields || row.fields);
          if (viewFields.length) break;
        } catch (_) {}
      }
  
      var keyMap = {};
      rows.forEach(function (row) {
        if (!row || typeof row !== "object") return;
        Object.keys(row).forEach(function (key) {
          var n = normalizeLooseKey(key);
          if (!n || keyMap[n]) return;
          keyMap[n] = key;
        });
      });
  
      function hasAnyValueForKey(actualKey) {
        if (!actualKey) return false;
        for (var r = 0; r < rows.length; r += 1) {
          var row = rows[r];
          if (!row || typeof row !== "object") continue;
          if (!Object.prototype.hasOwnProperty.call(row, actualKey)) continue;
          var value = row[actualKey];
          if (value != null && String(value).trim() !== "") return true;
        }
        return false;
      }
  
      // Default true so dynamic tables can reflect full repository/view schema.
      // Pass includeEmptyColumns:false only when callers explicitly want compact columns.
      var includeEmptyColumns = config.includeEmptyColumns !== false;
      var columns = [];
      var seen = {};
      viewFields.forEach(function (vf) {
        var internal = toSafeString(vf && (vf.dsNm || vf.FieldInternalName || vf.InternalName));
        var label = toSafeString(vf && (vf.dn || vf.DisplayName || vf.FieldName || internal));
        if (!internal) return;
        var normalized = normalizeLooseKey(internal);
        if (!normalized || seen[normalized]) return;
        var actualKey = keyMap[normalized] || internal;
        if (!includeEmptyColumns && !hasAnyValueForKey(actualKey)) return;
        seen[normalized] = true;
        columns.push({ key: actualKey, label: label || actualKey });
      });
  
      if (!columns.length) {
        columns = fallbackInferColumns(rows, {
          excludeKeys: Array.isArray(config.excludeKeys) ? config.excludeKeys : []
        });
      }
  
      return {
        rows: rows,
        columns: columns,
        viewFields: viewFields,
        raw: tableResult ? tableResult.raw : null,
        hasMore: Boolean(tableResult && tableResult.hasMore)
      };
    }
  
    // Keep newest records on top for default/unsorted views.
    function sortRowsNewestFirst(rows, options) {
      var list = Array.isArray(rows) ? rows.slice() : [];
      var config = options || {};
      var dateKeys = Array.isArray(config.dateKeys) && config.dateKeys.length
        ? config.dateKeys
        : ["CreatedDate", "Created Date", "ModifiedDate", "Modified Date"];
  
      function toTime(value) {
        if (value == null || value === "") return null;
        var ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : null;
      }
  
      function readRowTime(row) {
        if (!row || typeof row !== "object") return null;
        for (var i = 0; i < dateKeys.length; i += 1) {
          var key = dateKeys[i];
          if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
          var parsed = toTime(row[key]);
          if (parsed != null) return parsed;
        }
        return null;
      }
  
      return list
        .map(function (row, index) {
          return { row: row, index: index, time: readRowTime(row) };
        })
        .sort(function (a, b) {
          if (a.time != null && b.time != null) {
            if (a.time !== b.time) return b.time - a.time;
            return a.index - b.index;
          }
          if (a.time != null) return -1;
          if (b.time != null) return 1;
          return a.index - b.index;
        })
        .map(function (entry) {
          return entry.row;
        });
    }
  
    // Dedupe/append rows by stable key while preserving input order.
    function appendUniqueRows(existingRows, incomingRows, keyResolver) {
      var current = Array.isArray(existingRows) ? existingRows.slice() : [];
      var nextRows = Array.isArray(incomingRows) ? incomingRows : [];
      var keyFn =
        typeof keyResolver === "function"
          ? keyResolver
          : function (row) {
              var rid = toSafeString(
                row &&
                  (row.RecordID ||
                    row.RecordId ||
                    row.recordid ||
                    row.ID ||
                    row.Id ||
                    row.id)
              );
              if (rid) return "rid:" + rid;
              var serial = toSafeString(row && (row.SerialNumber || row["SerialNo."]));
              var name = toSafeString(row && row.AssetName);
              if (serial || name) return "sn:" + serial + "|nm:" + name;
              return "";
            };
  
      var seen = {};
      current.forEach(function (row, index) {
        var key = keyFn(row, index);
        if (key) seen[key] = true;
      });
  
      for (var i = 0; i < nextRows.length; i += 1) {
        var candidate = nextRows[i];
        var cKey = keyFn(candidate, current.length + i);
        if (cKey && seen[cKey]) continue;
        if (cKey) seen[cKey] = true;
        current.push(candidate);
      }
      return current;
    }
  
    // Reusable infinite loader: fetches 10, then 10 on scroll end until completion.
    function createInfinitePager(options) {
      var config = options || {};
      var pageSize = Number(config.pageSize || 10);
      if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 10;
      var loadMoreOffsetPx = Number(config.loadMoreOffsetPx || 180);
      if (!Number.isFinite(loadMoreOffsetPx) || loadMoreOffsetPx < 0) loadMoreOffsetPx = 180;
      var rootMargin = String(config.rootMargin || "320px 0px");
      var observeTarget = config.observeTarget || null;
      var scrollContainer = config.scrollContainer || window;
      var fetchPage = config.fetchPage;
      if (typeof fetchPage !== "function") {
        throw new Error("createInfinitePager requires fetchPage(page, pageSize, signal).");
      }
      var onRows = typeof config.onRows === "function" ? config.onRows : function () {};
      var onError = typeof config.onError === "function" ? config.onError : function () {};
      var onState = typeof config.onState === "function" ? config.onState : function () {};
      var dedupeBy = typeof config.dedupeBy === "function" ? config.dedupeBy : null;
      var sortNewestFirst = Boolean(config.sortNewestFirst);
      var sortDateKeys = Array.isArray(config.sortDateKeys) ? config.sortDateKeys : null;
  
      var state = {
        page: 1,
        pageSize: pageSize,
        hasMore: true,
        isLoading: false,
        rows: [],
        loadedBatches: 0
      };
      var activeAbort = null;
      var activeToken = 0;
      var observer = null;
  
      function emitState() {
        onState({
          page: state.page,
          pageSize: state.pageSize,
          hasMore: state.hasMore,
          isLoading: state.isLoading,
          loadedBatches: state.loadedBatches,
          totalRows: state.rows.length
        });
      }
  
      function normalizeRowsFromPayload(payload) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== "object") return [];
        if (Array.isArray(payload.rows)) return payload.rows;
        if (Array.isArray(payload.data)) return payload.data;
        return [];
      }
  
      function resolveHasMore(payload, rowsCount) {
        if (payload && typeof payload === "object" && typeof payload.hasMore === "boolean") {
          return payload.hasMore;
        }
        if (payload && typeof payload === "object" && Number.isFinite(Number(payload.totalCount))) {
          var total = Number(payload.totalCount);
          return state.rows.length < total;
        }
        return rowsCount >= state.pageSize;
      }
  
      async function loadNext() {
        if (state.isLoading || !state.hasMore) return { skipped: true };
  
        state.isLoading = true;
        emitState();
  
        if (activeAbort) {
          try {
            activeAbort.abort();
          } catch (_) {}
        }
        activeAbort = new AbortController();
        activeToken += 1;
        var token = activeToken;
  
        try {
          var payload = await fetchPage(state.page, state.pageSize, activeAbort.signal);
          if (token !== activeToken) return { skipped: true };
  
          var rows = normalizeRowsFromPayload(payload);
          if (dedupeBy) state.rows = appendUniqueRows(state.rows, rows, dedupeBy);
          else state.rows = state.rows.concat(rows);
  
          if (sortNewestFirst) {
            state.rows = sortRowsNewestFirst(state.rows, { dateKeys: sortDateKeys || undefined });
          }
  
          state.loadedBatches += 1;
          state.hasMore = resolveHasMore(payload, rows.length);
          if (state.hasMore) state.page += 1;
  
          onRows(state.rows.slice(), {
            batchRows: rows,
            loadedBatches: state.loadedBatches,
            hasMore: state.hasMore,
            nextPage: state.page
          });
  
          return { skipped: false, rows: rows, hasMore: state.hasMore };
        } catch (error) {
          if (!error || error.name !== "AbortError") onError(error);
          return { skipped: false, error: error };
        } finally {
          if (token === activeToken) {
            state.isLoading = false;
            emitState();
          }
        }
      }
  
      function nearBottom() {
        var docEl = document.documentElement;
        if (!docEl) return false;
        var viewportBottom = window.scrollY + window.innerHeight;
        var pageBottom = docEl.scrollHeight;
        return viewportBottom >= pageBottom - loadMoreOffsetPx;
      }
  
      function onScrollCheck() {
        if (!state.hasMore || state.isLoading) return;
        if (nearBottom()) loadNext();
      }
  
      function connect() {
        disconnect();
        if (typeof IntersectionObserver === "function" && observeTarget) {
          observer = new IntersectionObserver(
            function (entries) {
              var entry = entries && entries[0];
              if (!entry || !entry.isIntersecting) return;
              loadNext();
            },
            { root: null, rootMargin: rootMargin, threshold: 0 }
          );
          observer.observe(observeTarget);
        }
        if (scrollContainer && typeof scrollContainer.addEventListener === "function") {
          scrollContainer.addEventListener("scroll", onScrollCheck, { passive: true });
        }
      }
  
      function disconnect() {
        if (observer) {
          try {
            observer.disconnect();
          } catch (_) {}
          observer = null;
        }
        if (scrollContainer && typeof scrollContainer.removeEventListener === "function") {
          scrollContainer.removeEventListener("scroll", onScrollCheck);
        }
      }
  
      async function reset(nextOptions) {
        var opt = nextOptions || {};
        if (activeAbort) {
          try {
            activeAbort.abort();
          } catch (_) {}
        }
        activeToken += 1;
        state.page = Number(opt.page || 1);
        if (!Number.isFinite(state.page) || state.page <= 0) state.page = 1;
        state.pageSize = Number(opt.pageSize || state.pageSize || 10);
        if (!Number.isFinite(state.pageSize) || state.pageSize <= 0) state.pageSize = 10;
        state.hasMore = true;
        state.isLoading = false;
        state.rows = [];
        state.loadedBatches = 0;
        emitState();
        if (opt.autoLoad !== false) {
          return loadNext();
        }
        return { skipped: false };
      }
  
      function destroy() {
        disconnect();
        if (activeAbort) {
          try {
            activeAbort.abort();
          } catch (_) {}
        }
        activeAbort = null;
      }
  
      return {
        loadNext: loadNext,
        reset: reset,
        connect: connect,
        disconnect: disconnect,
        destroy: destroy,
        getState: function () {
          return {
            page: state.page,
            pageSize: state.pageSize,
            hasMore: state.hasMore,
            isLoading: state.isLoading,
            loadedBatches: state.loadedBatches,
            totalRows: state.rows.length
          };
        }
      };
    }
  
    // Reusable add-record wrapper with CreateItem/AddItems fallback.
    async function addRepositoryRecord(options) {
      var config = options || {};
      var objectName = toSafeString(config.objectName || config.repositoryName || config.repository);
      var item = config.item || config.record || {};
      if (!objectName) throw new Error("objectName or repositoryName is required.");
      if (!item || typeof item !== "object") throw new Error("item/record must be an object.");
  
      var qafService = getQafService();
      if (!qafService) throw new Error("QafService is not available.");
  
      if (typeof qafService.CreateItem === "function") {
        var createPayload = { ObjectName: objectName, Items: [item] };
        return qafService.CreateItem(createPayload);
      }
  
      if (typeof qafService.AddItems === "function") {
        var addPayload = [{ ObjectName: objectName, Items: [item] }];
        return qafService.AddItems(addPayload);
      }
  
      throw new Error("No supported add API found on QafService.");
    }
  
    // Open OOTB add form through whichever add method is available.
    function openAddForm(options) {
      var config = options || {};
      var targets = asRepositoryTargets(config.repositoryName || config.repository, config.objectID || config.objectId);
      var onDone = typeof config.onDone === "function" ? config.onDone : function () {};
      if (!targets.length) return false;
      var argSets = targets.map(function (target) {
        return [target, onDone];
      });
      return callQafPageServiceMethod(
        ["AddItem", "AddNewItem", "CreateItem", "OpenCreateItem", "OpenNewItem", "NewItem"],
        argSets
      );
    }
  
    // Open OOTB view form for a specific record.
    function openViewForm(options) {
      var config = options || {};
      var recordID = toSafeString(config.recordID || config.recordId || config.id);
      var targets = asRepositoryTargets(config.repositoryName || config.repository, config.objectID || config.objectId);
      var onDone = typeof config.onDone === "function" ? config.onDone : function () {};
      if (!recordID || !targets.length) return false;
      var argSets = [];
      for (var i = 0; i < targets.length; i += 1) {
        argSets.push([targets[i], recordID, onDone]);
        argSets.push([targets[i], recordID]);
      }
      argSets.push([recordID, onDone]);
      argSets.push([recordID]);
      return callQafPageServiceMethod(["ViewItem"], argSets);
    }
  
    // Open OOTB edit form for a specific record.
    function openEditForm(options) {
      var config = options || {};
      var recordID = toSafeString(config.recordID || config.recordId || config.id);
      var targets = asRepositoryTargets(config.repositoryName || config.repository, config.objectID || config.objectId);
      var onDone = typeof config.onDone === "function" ? config.onDone : function () {};
      if (!recordID || !targets.length) return false;
      var argSets = [];
      for (var i = 0; i < targets.length; i += 1) {
        argSets.push([targets[i], recordID, onDone]);
        argSets.push([targets[i], recordID]);
      }
      argSets.push([recordID, onDone]);
      argSets.push([recordID]);
      return callQafPageServiceMethod(["EditItem"], argSets);
    }
  
    // Delete a record through the page service.
    function deleteRecord(options) {
      var config = options || {};
      var recordID = toSafeString(config.recordID || config.recordId || config.id);
      var onDone = typeof config.onDone === "function" ? config.onDone : function () {};
      if (!recordID) return false;
      return callQafPageServiceMethod(
        ["DeleteItem"],
        [
          [recordID, onDone],
          [recordID]
        ]
      );
    }
  
    // Unified OOTB form dispatcher: add/view/edit/delete.
    function openOotbForm(options) {
      var config = options || {};
      var mode = toSafeString(config.mode || "add").toLowerCase();
      if (mode === "view") return openViewForm(config);
      if (mode === "edit") return openEditForm(config);
      if (mode === "delete") return deleteRecord(config);
      return openAddForm(config);
    }
  
    // Display dates as DD/MM/YYYY (functional spec for requisition grids).
    function pad2(n) {
      return String(n).length < 2 ? "0" + n : String(n);
    }
  
    function formatDateDDMMYYYY(value) {
      if (value == null || value === "") return "";
      if (value instanceof Date) {
        var d0 = value;
        if (!Number.isFinite(d0.getTime())) return "";
        return pad2(d0.getDate()) + "/" + pad2(d0.getMonth() + 1) + "/" + d0.getFullYear();
      }
      var s = String(value).trim();
      if (!s) return "";
      var isoDay = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
      if (isoDay) {
        return pad2(Number(isoDay[3])) + "/" + pad2(Number(isoDay[2])) + "/" + Number(isoDay[1]);
      }
      var parsed = new Date(s);
      if (Number.isFinite(parsed.getTime())) {
        return pad2(parsed.getDate()) + "/" + pad2(parsed.getMonth() + 1) + "/" + parsed.getFullYear();
      }
      return s;
    }
  
    // Reusable row action dispatcher for table menus (view/edit/delete).
    function dispatchRowAction(options) {
      var config = options || {};
      var action = toSafeString(config.action || config.mode).toLowerCase();
      if (!action) return false;
      if (action !== "view" && action !== "edit" && action !== "delete") return false;
      return openOotbForm({
        mode: action,
        recordID: config.recordID || config.recordId || config.id,
        repositoryName: config.repositoryName || config.repository,
        objectID: config.objectID || config.objectId,
        onDone: config.onDone
      });
    }
  
    // Reusable CSV exporter for table/grid rows.
    function exportCsv(options) {
      var config = options || {};
      var rows = Array.isArray(config.rows) ? config.rows : [];
      var filename = toSafeString(config.filename) || "export.csv";
      var includeHeaders = config.includeHeaders !== false;
      var delimiter = toSafeString(config.delimiter) || ",";
      var lineBreak = toSafeString(config.lineBreak) || "\n";
      var includeBom = config.includeBom !== false;
      var valueResolver = typeof config.valueResolver === "function" ? config.valueResolver : null;
  
      function normalizeColumn(col) {
        if (col == null) return null;
        if (typeof col === "string") {
          var keyText = toSafeString(col);
          if (!keyText) return null;
          return { key: keyText, label: keyText };
        }
        if (typeof col === "object") {
          var key = toSafeString(col.key || col.field || col.name || col.label);
          if (!key) return null;
          var label = toSafeString(col.label || col.title || key) || key;
          return { key: key, label: label };
        }
        return null;
      }
  
      function inferColumnsFromRows(rowsInput) {
        var seen = {};
        var out = [];
        for (var i = 0; i < rowsInput.length; i += 1) {
          var row = rowsInput[i];
          if (!row || typeof row !== "object") continue;
          var keys = Object.keys(row);
          for (var k = 0; k < keys.length; k += 1) {
            var key = toSafeString(keys[k]);
            if (!key) continue;
            var lower = key.toLowerCase();
            if (seen[lower]) continue;
            seen[lower] = true;
            out.push({ key: key, label: key });
          }
        }
        return out;
      }
  
      var providedColumns = Array.isArray(config.columns) ? config.columns : [];
      var columns = providedColumns.map(normalizeColumn).filter(Boolean);
      if (!columns.length) columns = inferColumnsFromRows(rows);
      if (!columns.length) columns = [{ key: "RecordID", label: "RecordID" }];
  
      function toCellText(value) {
        if (value == null) return "";
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "object") return lookupToText(value, "");
        return String(value);
      }
  
      function quoteCsvCell(value) {
        var text = String(value == null ? "" : value);
        return '"' + text.replace(/"/g, '""') + '"';
      }
  
      var lines = [];
      if (includeHeaders) {
        lines.push(
          columns
            .map(function (c) {
              return quoteCsvCell(c.label);
            })
            .join(delimiter)
        );
      }
  
      for (var r = 0; r < rows.length; r += 1) {
        var rowValue = rows[r];
        var csvRow = columns
          .map(function (col, cIndex) {
            var raw = valueResolver
              ? valueResolver({
                  row: rowValue,
                  column: col,
                  rowIndex: r,
                  columnIndex: cIndex,
                  defaultValue: rowValue && typeof rowValue === "object" ? rowValue[col.key] : ""
                })
              : rowValue && typeof rowValue === "object"
                ? rowValue[col.key]
                : "";
            return quoteCsvCell(toCellText(raw));
          })
          .join(delimiter);
        lines.push(csvRow);
      }
  
      var csvText = (includeBom ? "\uFEFF" : "") + lines.join(lineBreak);
      var blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
  
      return {
        filename: filename,
        rowCount: rows.length,
        columnCount: columns.length,
        csvText: csvText
      };
    }
  
    window.QafLibrary = {
      getQafService: getQafService,
      getQafPageService: getQafPageService,
      toAbsolutePageUrl: toAbsolutePageUrl,
      buildPageUrl: buildPageUrl,
      navigateToPage: navigateToPage,
      lookupToText: lookupToText,
      enrichRowsWithLookupText: enrichRowsWithLookupText,
      fetchRepositoryData: fetchRepositoryData,
      fetchRepositoryPage: fetchRepositoryPage,
      fetchRepositoryRowsForTable: fetchRepositoryRowsForTable,
      fetchRepositoryViewTableModel: fetchRepositoryViewTableModel,
      sortRowsNewestFirst: sortRowsNewestFirst,
      appendUniqueRows: appendUniqueRows,
      createInfinitePager: createInfinitePager,
      addRepositoryRecord: addRepositoryRecord,
      openAddForm: openAddForm,
      openViewForm: openViewForm,
      openEditForm: openEditForm,
      deleteRecord: deleteRecord,
      openOotbForm: openOotbForm,
      dispatchRowAction: dispatchRowAction,
      exportCsv: exportCsv,
      formatDateDDMMYYYY: formatDateDDMMYYYY
    };
  })();
  
  (function () {
    "use strict";
  
    // Generic, reusable dynamic table engine for all pages.
    var DYNAMIC_DEFAULTS = {
      pageSize: 10,
      tableClass: "qaf-dynamic-table",
      sortable: true,
      resizable: true,
      resizeStorageKey: "",
      minWidth: 100,
      maxWidth: 420,
      emptyText: "No records found.",
      showActions: false,
      actionsColumnWidth: 32
    };
  
    // Escape helper for safe HTML rendering.
    function htmlEscape(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
  
    // Normalize a value for key comparisons.
    function normalizeKey(value) {
      return String(value || "")
        .trim()
        .toLowerCase();
    }
  
    // Robust record id resolver across common key variants.
    function resolveRecordID(row) {
      if (!row || typeof row !== "object") return "";
      var keys = ["RecordID", "RecordId", "recordId", "recordid", "ID", "Id", "id", "__recordID"];
      for (var i = 0; i < keys.length; i += 1) {
        var v = row[keys[i]];
        if (v != null && String(v).trim() !== "") return String(v).trim();
      }
      return "";
    }
  
    // Build stable row key from RecordID or row index fallback.
    function resolveRowKey(row, index) {
      var rid = resolveRecordID(row);
      return rid ? "rid:" + rid : "idx:" + String(index);
    }
  
    // Infer columns from row shape, preserving first-seen key order.
    function inferColumnsFromRows(rows, options) {
      var config = options || {};
      var includeKeys = Array.isArray(config.includeKeys) ? config.includeKeys : null;
      var exclude = {};
      (Array.isArray(config.excludeKeys) ? config.excludeKeys : []).forEach(function (k) {
        exclude[normalizeKey(k)] = true;
      });
  
      var preferredOrder = Array.isArray(config.preferredOrder) ? config.preferredOrder : [];
      var discovered = [];
      var seen = {};
      var safeRows = Array.isArray(rows) ? rows : [];
  
      for (var r = 0; r < safeRows.length; r += 1) {
        var row = safeRows[r];
        if (!row || typeof row !== "object") continue;
        var keys = Object.keys(row);
        for (var i = 0; i < keys.length; i += 1) {
          var key = keys[i];
          var keyNorm = normalizeKey(key);
          if (!keyNorm || seen[keyNorm]) continue;
          if (exclude[keyNorm]) continue;
          if (includeKeys && includeKeys.indexOf(key) === -1) continue;
          seen[keyNorm] = true;
          discovered.push(key);
        }
      }
  
      if (preferredOrder.length) {
        discovered.sort(function (a, b) {
          var ai = preferredOrder.indexOf(a);
          var bi = preferredOrder.indexOf(b);
          if (ai === -1 && bi === -1) return 0;
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        });
      }
  
      return discovered.map(function (key) {
        return { key: key, label: String(key) };
      });
    }
  
    // Normalize user-provided columns to a stable schema object.
    function normalizeColumns(columns) {
      var safe = Array.isArray(columns) ? columns : [];
      return safe
        .filter(function (c) {
          return c && (c.key || c.label);
        })
        .map(function (c) {
          return {
            key: String(c.key || c.label || "").trim(),
            label: String(c.label || c.key || "").trim(),
            type: c.type || "text",
            className: String(c.className || "").trim(),
            noSort: Boolean(c.noSort),
            noResize: Boolean(c.noResize),
            // formatter(value, row, column) => html or text
            formatter: typeof c.formatter === "function" ? c.formatter : null
          };
        })
        .filter(function (c) {
          return c.key;
        });
    }
  
    // Build table shell and pager controls.
    function buildDynamicShell(host, model) {
      var cols = model.columns;
      var options = model.options;
      host.innerHTML =
        '<section class="panel table-panel">' +
        '<div class="table-panel__top">' +
        '<div class="table-panel__meta"><strong data-role="count">0</strong> <span data-role="scope">records</span></div>' +
        '<div class="table-panel__actions">' +
        '<button type="button" class="btn btn--dark" data-role="prev" disabled>Previous</button>' +
        '<button type="button" class="btn btn--dark" data-role="next" disabled>Next</button>' +
        "</div></div>" +
        '<div class="table-wrap">' +
        '<table class="' +
        htmlEscape(options.tableClass) +
        '" aria-label="' +
        htmlEscape(options.ariaLabel || "Dynamic table") +
        '">' +
        "<colgroup>" +
        (options.showActions
          ? '<col class="row-actions-col" style="width:' + Number(options.actionsColumnWidth || 32) + 'px;">'
          : "") +
        cols
          .map(function () {
            return "<col>";
          })
          .join("") +
        "</colgroup>" +
        "<thead><tr>" +
        (options.showActions ? '<th class="row-actions-head no-sort no-resize" aria-label="Actions"></th>' : "") +
        cols
          .map(function (column) {
            var classes = [];
            if (column.noSort) classes.push("no-sort");
            if (column.noResize) classes.push("no-resize");
            return '<th class="' + htmlEscape(classes.join(" ")) + '">' + htmlEscape(column.label || column.key) + "</th>";
          })
          .join("") +
        "</tr></thead>" +
        '<tbody data-role="tbody"></tbody>' +
        "</table>" +
        "</div>" +
        '<div class="table-panel__footer"><span data-role="hint" class="load-more-hint"></span></div>' +
        "</section>";
    }
  
    // Resolve value for a column from row with key fallback.
    function getColumnValue(row, column) {
      if (!row || typeof row !== "object") return "";
      if (Object.prototype.hasOwnProperty.call(row, column.key)) return row[column.key];
      if (Object.prototype.hasOwnProperty.call(row, column.label)) return row[column.label];
      return "";
    }
  
    // Render one table page.
    function renderDynamicRows(model, pageRows, pageStartIndex) {
      var tbody = model.elements.tbody;
      if (!tbody) return;
      var cols = model.columns;
      var options = model.options;
  
      if (!pageRows.length) {
        var colspan = cols.length + (options.showActions ? 1 : 0);
        tbody.innerHTML = '<tr><td colspan="' + colspan + '">' + htmlEscape(options.emptyText) + "</td></tr>";
        return;
      }
  
      tbody.innerHTML = pageRows
        .map(function (row, idx) {
          var realIndex = pageStartIndex + idx;
          var rowKey = resolveRowKey(row, realIndex);
          var actionsCell = "";
          if (options.showActions) {
            actionsCell =
              '<td class="row-actions" data-row-key="' +
              htmlEscape(rowKey) +
              '">' +
              '<button class="row-actions__toggle" type="button" data-row-menu-toggle data-row-key="' +
              htmlEscape(rowKey) +
              '" aria-label="Open actions"><i class="fa fa-ellipsis-v" aria-hidden="true"></i></button>' +
              '<div class="row-actions__menu" hidden>' +
              '<button type="button" class="row-actions__item" data-row-action="view" data-row-key="' +
              htmlEscape(rowKey) +
              '"><i class="fa fa-eye" aria-hidden="true"></i><span>View</span></button>' +
              '<button type="button" class="row-actions__item" data-row-action="edit" data-row-key="' +
              htmlEscape(rowKey) +
              '"><i class="fa fa-pencil" aria-hidden="true"></i><span>Edit</span></button>' +
              '<button type="button" class="row-actions__item" data-row-action="delete" data-row-key="' +
              htmlEscape(rowKey) +
              '"><i class="fa fa-trash-o" aria-hidden="true"></i><span>Delete</span></button>' +
              "</div>" +
              "</td>";
          }
  
          var cells = cols
            .map(function (column) {
              var raw = getColumnValue(row, column);
              var text = raw == null ? "" : String(raw);
              var rendered = column.formatter ? column.formatter(raw, row, column) : htmlEscape(text);
              var cls = column.className ? ' class="' + htmlEscape(column.className) + '"' : "";
              return "<td" + cls + ">" + rendered + "</td>";
            })
            .join("");
  
          return "<tr>" + actionsCell + cells + "</tr>";
        })
        .join("");
    }
  
    // Bind row menu and action callbacks for dynamic table.
    function bindDynamicActions(model) {
      if (!model.options.showActions) return;
      var wrap = model.elements.tableWrap;
      if (!wrap || wrap.__dynamicActionsBound) return;
      wrap.__dynamicActionsBound = true;
  
      function closeMenus() {
        model.host.querySelectorAll(".row-actions__menu").forEach(function (m) {
          m.setAttribute("hidden", "");
          m.classList.remove("is-open");
        });
      }
  
      function getRowByKey(rowKey) {
        for (var i = 0; i < model.rows.length; i += 1) {
          if (resolveRowKey(model.rows[i], i) === rowKey) return model.rows[i];
        }
        return null;
      }
  
      wrap.addEventListener("click", function (event) {
        var menuToggle = event.target.closest("[data-row-menu-toggle]");
        if (menuToggle) {
          event.preventDefault();
          event.stopPropagation();
          var rowCell = menuToggle.closest(".row-actions");
          if (!rowCell) return;
          var menu = rowCell.querySelector(".row-actions__menu");
          if (!menu) return;
          var isHidden = menu.hasAttribute("hidden");
          closeMenus();
          if (isHidden) {
            menu.removeAttribute("hidden");
            menu.classList.add("is-open");
          }
          return;
        }
  
        var actionBtn = event.target.closest("[data-row-action]");
        if (!actionBtn) return;
        event.preventDefault();
        var action = String(actionBtn.getAttribute("data-row-action") || "").toLowerCase();
        var rowKey = String(actionBtn.getAttribute("data-row-key") || "");
        if (!rowKey) return;
        var row = getRowByKey(rowKey);
        if (!row) return;
        var rid = resolveRecordID(row);
        if (!rid) return;
  
        if (typeof model.options.onAction === "function") {
          model.options.onAction(action, row, rid);
        } else if (window.QafLibrary && typeof window.QafLibrary.dispatchRowAction === "function") {
          window.QafLibrary.dispatchRowAction({
            action: action,
            recordID: rid,
            repositoryName: model.options.repositoryName,
            objectID: model.options.objectID
          });
        } else if (window.QafLibrary && typeof window.QafLibrary.openOotbForm === "function") {
          window.QafLibrary.openOotbForm({
            mode: action,
            recordID: rid,
            repositoryName: model.options.repositoryName,
            objectID: model.options.objectID
          });
        }
        closeMenus();
      });
  
      document.addEventListener("click", function (event) {
        if (model.host.contains(event.target)) return;
        closeMenus();
      });
    }
  
    // Keep pager counters and navigation state updated.
    function updateDynamicPager(model) {
      var rows = model.rows;
      var page = model.page;
      var size = model.options.pageSize;
      var start = rows.length ? (page - 1) * size + 1 : 0;
      var end = Math.min(page * size, rows.length);
      if (model.elements.countEl) model.elements.countEl.textContent = String(rows.length);
      if (model.elements.scopeEl) {
        model.elements.scopeEl.textContent = rows.length
          ? "records (showing " + start + "-" + end + ")"
          : "records";
      }
      if (model.elements.hintEl) {
        model.elements.hintEl.textContent = "";
      }
      if (model.elements.prevBtn) model.elements.prevBtn.disabled = page <= 1;
      if (model.elements.nextBtn) model.elements.nextBtn.disabled = page * size >= rows.length;
    }
  
    // Render current page and refresh GridTable hooks.
    function renderDynamicPage(model) {
      var size = model.options.pageSize;
      var start = (model.page - 1) * size;
      var pageRows = model.rows.slice(start, start + size);
      renderDynamicRows(model, pageRows, start);
      if (model.gridInstance && typeof model.gridInstance.refresh === "function") model.gridInstance.refresh();
      updateDynamicPager(model);
    }
  
    // Create a dynamic table model/controller instance.
    function createDynamicTable(host, options) {
      if (!host) throw new Error("host element is required.");
      var config = Object.assign({}, DYNAMIC_DEFAULTS, options || {});
      var rows = Array.isArray(config.rows) ? config.rows.slice() : [];
      var cols = normalizeColumns(config.columns);
      if (!cols.length) cols = normalizeColumns(inferColumnsFromRows(rows, config));
  
      var model = {
        host: host,
        rows: rows,
        columns: cols,
        page: 1,
        gridInstance: null,
        options: config,
        elements: {}
      };
  
      buildDynamicShell(host, model);
      model.elements.tbody = host.querySelector("[data-role='tbody']");
      model.elements.prevBtn = host.querySelector("[data-role='prev']");
      model.elements.nextBtn = host.querySelector("[data-role='next']");
      model.elements.scopeEl = host.querySelector("[data-role='scope']");
      model.elements.hintEl = host.querySelector("[data-role='hint']");
      model.elements.countEl = host.querySelector("[data-role='count']");
      model.elements.table = host.querySelector("table." + config.tableClass);
      model.elements.tableWrap = host.querySelector(".table-wrap");
  
      if (model.elements.table && window.GridTable && typeof window.GridTable.create === "function") {
        model.gridInstance = window.GridTable.create(model.elements.table, {
          sortable: config.sortable,
          resizable: config.resizable,
          resizeStorageKey: config.resizeStorageKey,
          minWidth: config.minWidth,
          maxWidth: config.maxWidth
        });
      }
  
      if (model.elements.prevBtn) {
        model.elements.prevBtn.addEventListener("click", function () {
          if (model.page > 1) {
            model.page -= 1;
            renderDynamicPage(model);
          }
        });
      }
      if (model.elements.nextBtn) {
        model.elements.nextBtn.addEventListener("click", function () {
          if (model.page * model.options.pageSize < model.rows.length) {
            model.page += 1;
            renderDynamicPage(model);
          }
        });
      }
  
      bindDynamicActions(model);
      renderDynamicPage(model);
  
      return {
        // Replace data rows; optionally infer schema from incoming data.
        setRows: function (nextRows, runtimeOptions) {
          var ro = runtimeOptions || {};
          model.rows = Array.isArray(nextRows) ? nextRows.slice() : [];
          if (ro.inferColumns) {
            model.columns = normalizeColumns(inferColumnsFromRows(model.rows, model.options));
            buildDynamicShell(model.host, model);
            model.elements.tbody = model.host.querySelector("[data-role='tbody']");
            model.elements.prevBtn = model.host.querySelector("[data-role='prev']");
            model.elements.nextBtn = model.host.querySelector("[data-role='next']");
            model.elements.scopeEl = model.host.querySelector("[data-role='scope']");
            model.elements.hintEl = model.host.querySelector("[data-role='hint']");
            model.elements.countEl = model.host.querySelector("[data-role='count']");
            model.elements.table = model.host.querySelector("table." + model.options.tableClass);
            model.elements.tableWrap = model.host.querySelector(".table-wrap");
            if (model.gridInstance && typeof model.gridInstance.destroy === "function") model.gridInstance.destroy();
            model.gridInstance = null;
            if (model.elements.table && window.GridTable && typeof window.GridTable.create === "function") {
              model.gridInstance = window.GridTable.create(model.elements.table, {
                sortable: model.options.sortable,
                resizable: model.options.resizable,
                resizeStorageKey: model.options.resizeStorageKey,
                minWidth: model.options.minWidth,
                maxWidth: model.options.maxWidth
              });
            }
            bindDynamicActions(model);
          }
          model.page = 1;
          renderDynamicPage(model);
        },
  
        // Replace schema explicitly.
        setColumns: function (nextColumns) {
          model.columns = normalizeColumns(nextColumns);
          buildDynamicShell(model.host, model);
          model.elements.tbody = model.host.querySelector("[data-role='tbody']");
          model.elements.prevBtn = model.host.querySelector("[data-role='prev']");
          model.elements.nextBtn = model.host.querySelector("[data-role='next']");
          model.elements.scopeEl = model.host.querySelector("[data-role='scope']");
          model.elements.hintEl = model.host.querySelector("[data-role='hint']");
          model.elements.countEl = model.host.querySelector("[data-role='count']");
          model.elements.table = model.host.querySelector("table." + model.options.tableClass);
          model.elements.tableWrap = model.host.querySelector(".table-wrap");
          if (model.gridInstance && typeof model.gridInstance.destroy === "function") model.gridInstance.destroy();
          model.gridInstance = null;
          if (model.elements.table && window.GridTable && typeof window.GridTable.create === "function") {
            model.gridInstance = window.GridTable.create(model.elements.table, {
              sortable: model.options.sortable,
              resizable: model.options.resizable,
              resizeStorageKey: model.options.resizeStorageKey,
              minWidth: model.options.minWidth,
              maxWidth: model.options.maxWidth
            });
          }
          bindDynamicActions(model);
          model.page = 1;
          renderDynamicPage(model);
        },
  
        // Reload using QafLibrary.fetchRepositoryData and refresh grid rows.
        reloadFromRepository: async function (fetchOptions) {
          if (!window.QafLibrary || typeof window.QafLibrary.fetchRepositoryData !== "function") {
            throw new Error("QafLibrary.fetchRepositoryData is not available.");
          }
          var result = await window.QafLibrary.fetchRepositoryData(fetchOptions || {});
          this.setRows(result.rows || [], { inferColumns: Boolean((fetchOptions || {}).inferColumns) });
          return result;
        },
  
        // Refresh existing view while retaining schema.
        refresh: function () {
          renderDynamicPage(model);
        },
  
        // Cleanup instance and DOM.
        destroy: function () {
          if (model.gridInstance && typeof model.gridInstance.destroy === "function") model.gridInstance.destroy();
          model.host.innerHTML = "";
        }
      };
    }
  
    window.GridDataTable = {
      inferColumnsFromRows: inferColumnsFromRows,
      create: createDynamicTable
    };
  
    // Expose dynamic helpers through QafLibrary for single import surface.
    window.QafLibrary = Object.assign({}, window.QafLibrary || {}, {
      inferColumnsFromRows: inferColumnsFromRows,
      createDynamicTable: createDynamicTable
    });
  })();

  (function () {
    "use strict";

    // =====================================================================
    // Reusable dropdown helpers (styling reference: the toolbar "All Types"
    // dropdown). Any page can use these instead of re-implementing an
    // open/close list, an outside-click-to-close handler, and a
    // viewport-safe floating panel.
    // =====================================================================

    // Positions a floating list against its trigger by portaling it to
    // <body> while open, so it is never clipped by an ancestor's overflow.
    // root/trigger/list are plain elements; call attach() to open,
    // detach() to close, reposition() to re-measure (e.g. on external resize).
    function createDropdownPortal(root, trigger, list) {
      var anchor = document.createComment("qaf-dropdown-portal");
      var isPortaled = false;

      function positionList() {
        if (!isPortaled) return;
        var rect = trigger.getBoundingClientRect();
        var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

        list.style.right = "auto";
        list.style.bottom = "auto";
        list.style.minWidth = "";
        list.style.maxWidth = "";
        list.style.width = rect.width + "px";

        var listWidth = list.offsetWidth;
        var left = rect.left;
        if (left + listWidth > viewportWidth - 8) {
          left = Math.max(8, viewportWidth - 8 - listWidth);
        }
        list.style.left = left + "px";

        var listHeight = list.offsetHeight;
        var spaceBelow = viewportHeight - rect.bottom - 8;
        if (spaceBelow < listHeight && rect.top - 8 > spaceBelow) {
          list.style.top = Math.max(4, rect.top - 4 - listHeight) + "px";
        } else {
          list.style.top = rect.bottom + 4 + "px";
        }
      }

      function attach() {
        if (!isPortaled) {
          if (list.parentNode) list.parentNode.insertBefore(anchor, list);
          document.body.appendChild(list);
          list.classList.add("qaf-dd-menu--portal");
          isPortaled = true;
          window.addEventListener("scroll", positionList, true);
          window.addEventListener("resize", positionList);
        }
        positionList();
      }

      function detach() {
        if (!isPortaled) return;
        window.removeEventListener("scroll", positionList, true);
        window.removeEventListener("resize", positionList);
        list.classList.remove("qaf-dd-menu--portal");
        list.style.top = "";
        list.style.left = "";
        list.style.right = "";
        list.style.bottom = "";
        list.style.width = "";
        list.style.minWidth = "";
        list.style.maxWidth = "";
        if (anchor.parentNode) {
          anchor.parentNode.insertBefore(list, anchor);
          anchor.parentNode.removeChild(anchor);
        } else if (root) {
          root.appendChild(list);
        }
        isPortaled = false;
      }

      return { attach: attach, detach: detach, reposition: positionList };
    }

    // Shared registry so any number of open dropdowns/menus can be closed
    // together on an outside click or Escape, without each page wiring its
    // own document-level listeners.
    var outsideCloseHandlers = [];
    var outsideCloseBound = false;
    function bindOutsideClose() {
      if (outsideCloseBound) return;
      outsideCloseBound = true;
      document.addEventListener("click", function (event) {
        outsideCloseHandlers.forEach(function (entry) {
          if (!entry.contains(event.target)) entry.close();
        });
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          outsideCloseHandlers.forEach(function (entry) {
            entry.close();
          });
        }
      });
    }

    // contains(target) should return true when target is part of the
    // dropdown (trigger or list) and a click there should NOT close it.
    function registerOutsideClose(contains, close) {
      bindOutsideClose();
      outsideCloseHandlers.push({ contains: contains, close: close });
    }

    // Shows/hides a small inline clear ("x") control based on whether a
    // value is present. Shared by dropdown clear buttons and search bars.
    function toggleClearVisibility(clearBtn, hasValue) {
      if (!clearBtn) return;
      if (hasValue) clearBtn.removeAttribute("hidden");
      else clearBtn.setAttribute("hidden", "");
    }

    // =====================================================================
    // Reusable search bar behavior: wires a text input + optional clear
    // button so both dashboards (and future pages) share one implementation
    // of "show clear button when there's text, clear on click, Enter to
    // submit".
    // =====================================================================
    function bindSearchClear(input, clearBtn, callbacks) {
      if (!input) return null;
      var opts = callbacks || {};

      function syncClearButton() {
        toggleClearVisibility(clearBtn, String(input.value || "").length > 0);
      }

      input.addEventListener("keydown", function (event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        syncClearButton();
        if (typeof opts.onEnter === "function") opts.onEnter(input.value);
      });

      input.addEventListener("input", function () {
        syncClearButton();
        if (typeof opts.onInput === "function") opts.onInput(input.value);
      });

      if (clearBtn) {
        clearBtn.addEventListener("click", function () {
          input.value = "";
          syncClearButton();
          if (typeof opts.onClear === "function") opts.onClear();
          input.focus();
        });
      }

      syncClearButton();
      return { syncClearButton: syncClearButton };
    }

    // =====================================================================
    // Reusable API date parsing/formatting.
    // parseApiDateValue supports every format the backend is known to send:
    //   - "M/D/YYYY h:mm:ss AM/PM" (month-first, with day/month
    //     disambiguation so a day > 12 is never mistaken for a month)
    //   - "YYYY-MM-DDTHH:mm:ss" (no zone suffix -> treated as UTC)
    //   - ISO strings with "Z" or an explicit +HH:mm / -HH:mm offset
    //   - "/Date(1690000000000)/" (.NET serialised dates)
    //   - "DD/MM/YYYY HH:mm:ss" (this library's own display strings)
    //   - Date objects and epoch numbers
    // Returns { date: Date, hasTime: boolean } or null.
    // =====================================================================
    function pad2(n) {
      return String(n).length < 2 ? "0" + n : String(n);
    }

    function parseApiDateValue(input) {
      if (input == null || input === "") return null;

      if (input instanceof Date) {
        return isFinite(input.getTime()) ? { date: input, hasTime: true } : null;
      }
      if (typeof input === "number" && isFinite(input)) {
        var fromEpoch = new Date(input);
        return isFinite(fromEpoch.getTime()) ? { date: fromEpoch, hasTime: true } : null;
      }

      var text = String(input).trim();
      if (!text) return null;

      // .NET: /Date(1690000000000)/ or /Date(1690000000000+0530)/
      var dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(text);
      if (dotNet) {
        var fromTicks = new Date(Number(dotNet[1]));
        return isFinite(fromTicks.getTime()) ? { date: fromTicks, hasTime: true } : null;
      }

      // ISO-8601: 2026-07-28T05:24:37 (bare = UTC), optionally with Z or an offset.
      var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
        text
      );
      if (iso) {
        var isoHasTime = iso[4] != null;
        var zone = iso[8] || "";
        if (zone) {
          var zoned = new Date(text.replace(" ", "T"));
          return isFinite(zoned.getTime()) ? { date: zoned, hasTime: isoHasTime } : null;
        }
        var millisText = iso[7] != null ? String(iso[7]).slice(0, 3) : "";
        while (millisText.length && millisText.length < 3) millisText += "0";
        var isoUtc = new Date(
          Date.UTC(
            Number(iso[1]),
            Number(iso[2]) - 1,
            Number(iso[3]),
            isoHasTime ? Number(iso[4]) : 0,
            iso[5] != null ? Number(iso[5]) : 0,
            iso[6] != null ? Number(iso[6]) : 0,
            millisText ? Number(millisText) : 0
          )
        );
        return isFinite(isoUtc.getTime()) ? { date: isoUtc, hasTime: isoHasTime } : null;
      }

      // Slash format, with or without a time part and AM/PM suffix.
      var slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(?:([AaPp])\.?[Mm]\.?)?)?$/.exec(
        text
      );
      if (slash) {
        var first = Number(slash[1]);
        var second = Number(slash[2]);
        var year = Number(slash[3]);

        // The API sends month-first (MM/DD/YYYY). A first component above 12
        // can only be a day, which also lets DD/MM/YYYY display strings
        // (as produced by this library) round-trip correctly if re-parsed.
        var monthFirst = !(first > 12 && second <= 12);
        var month = monthFirst ? first : second;
        var day = monthFirst ? second : first;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;

        var slashHasTime = slash[4] != null;
        var hours = slashHasTime ? Number(slash[4]) : 0;
        var minutes = slash[5] != null ? Number(slash[5]) : 0;
        var seconds = slash[6] != null ? Number(slash[6]) : 0;
        var meridiem = slash[7] ? slash[7].toLowerCase() : "";
        if (meridiem === "p" && hours < 12) hours += 12;
        if (meridiem === "a" && hours === 12) hours = 0;

        var slashUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
        if (!isFinite(slashUtc.getTime())) return null;
        if (slashUtc.getUTCMonth() !== month - 1 || slashUtc.getUTCDate() !== day) return null;
        return { date: slashUtc, hasTime: slashHasTime };
      }

      var fallback = new Date(text);
      return isFinite(fallback.getTime()) ? { date: fallback, hasTime: true } : null;
    }

    // UTC epoch for a value, for sorting/range filtering. Returns null when
    // unparseable.
    function getApiDateSortValue(value) {
      var parsed = parseApiDateValue(value);
      if (!parsed) return null;
      var time = parsed.date.getTime();
      return isFinite(time) ? time : null;
    }

    // True when the value carries no time component (a calendar date only).
    function isApiDateValueDateOnly(value) {
      var parsed = parseApiDateValue(value);
      return parsed ? !parsed.hasTime : false;
    }

    // Converts a parsed UTC value into calendar/clock parts, optionally
    // shifted by the caller's resolved timezone offset (in minutes). A
    // value carrying no time component is never shifted, so a date-only
    // value can't roll onto the previous/next day.
    function getApiDateParts(value, offsetMinutes, applyOffset) {
      var parsed = parseApiDateValue(value);
      if (!parsed) return null;
      var shiftMinutes = applyOffset && parsed.hasTime ? (offsetMinutes || 0) : 0;
      var shifted = new Date(parsed.date.getTime() + shiftMinutes * 60000);
      if (!isFinite(shifted.getTime())) return null;
      return {
        day: shifted.getUTCDate(),
        month: shifted.getUTCMonth() + 1,
        year: shifted.getUTCFullYear(),
        hours: shifted.getUTCHours(),
        minutes: shifted.getUTCMinutes(),
        seconds: shifted.getUTCSeconds(),
        hasTime: parsed.hasTime
      };
    }

    // Date-only output: DD/MM/YYYY.
    function formatApiUserDate(value) {
      var parts = getApiDateParts(value, 0, false);
      if (!parts) return "";
      return pad2(parts.day) + "/" + pad2(parts.month) + "/" + parts.year;
    }

    // DateTime output, converted from UTC using the caller's offset:
    //   12 Hour -> DD/MM/YYYY hh:mm:ss AM/PM
    //   24 Hour -> DD/MM/YYYY HH:mm:ss
    function formatApiUserDateTime(value, offsetMinutes, is24Hour, includeSeconds) {
      var parts = getApiDateParts(value, offsetMinutes, true);
      if (!parts) return "";
      var withSeconds = includeSeconds !== false;
      var datePart = pad2(parts.day) + "/" + pad2(parts.month) + "/" + parts.year;
      var secondsPart = withSeconds ? ":" + pad2(parts.seconds) : "";

      if (is24Hour) {
        return datePart + " " + pad2(parts.hours) + ":" + pad2(parts.minutes) + secondsPart;
      }

      var meridiem = parts.hours >= 12 ? "PM" : "AM";
      var hour12 = parts.hours % 12 === 0 ? 12 : parts.hours % 12;
      return datePart + " " + pad2(hour12) + ":" + pad2(parts.minutes) + secondsPart + " " + meridiem;
    }

    window.QafLibrary = Object.assign({}, window.QafLibrary || {}, {
      Dropdown: {
        createPortal: createDropdownPortal,
        registerOutsideClose: registerOutsideClose,
        toggleClearVisibility: toggleClearVisibility
      },
      bindSearchClear: bindSearchClear,
      parseApiDateValue: parseApiDateValue,
      getApiDateSortValue: getApiDateSortValue,
      isApiDateValueDateOnly: isApiDateValueDateOnly,
      formatApiUserDate: formatApiUserDate,
      formatApiUserDateTime: formatApiUserDateTime
    });
  })();