(() => {
  'use strict';

  const SYMBOLS = Object.freeze({
    alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', varepsilon:'ϵ', zeta:'ζ', eta:'η', theta:'θ', vartheta:'ϑ',
    iota:'ι', kappa:'κ', lambda:'λ', mu:'μ', nu:'ν', xi:'ξ', omicron:'ο', pi:'π', varpi:'ϖ', rho:'ρ', varrho:'ϱ',
    sigma:'σ', varsigma:'ς', tau:'τ', upsilon:'υ', phi:'φ', varphi:'ϕ', chi:'χ', psi:'ψ', omega:'ω',
    Gamma:'Γ', Delta:'Δ', Theta:'Θ', Lambda:'Λ', Xi:'Ξ', Pi:'Π', Sigma:'Σ', Upsilon:'Υ', Phi:'Φ', Psi:'Ψ', Omega:'Ω',
    times:'×', cdot:'·', ast:'∗', pm:'±', mp:'∓', div:'÷', le:'≤', leq:'≤', ge:'≥', geq:'≥', neq:'≠', ne:'≠', approx:'≈',
    equiv:'≡', sim:'∼', cong:'≅', propto:'∝', in:'∈', notin:'∉', ni:'∋', subset:'⊂', subseteq:'⊆', supset:'⊃', supseteq:'⊇',
    cup:'∪', cap:'∩', emptyset:'∅', forall:'∀', exists:'∃', partial:'∂', nabla:'∇', infty:'∞', therefore:'∴', because:'∵',
    to:'→', rightarrow:'→', leftarrow:'←', leftrightarrow:'↔', Rightarrow:'⇒', Leftarrow:'⇐', Leftrightarrow:'⇔',
    sum:'∑', prod:'∏', int:'∫', iint:'∬', iiint:'∭', oint:'∮',
    ldots:'…', cdots:'⋯', vdots:'⋮', ddots:'⋱', ell:'ℓ', Re:'ℜ', Im:'ℑ', angle:'∠', perp:'⊥', parallel:'∥'
  });

  const FUNCTIONS = new Set(['sin','cos','tan','cot','sec','csc','sinh','cosh','tanh','log','ln','exp','max','min','sup','inf','lim','det','gcd','Pr']);
  const BIG_OPERATORS = new Set(['sum','prod','int','iint','iiint','oint','lim']);

  function escapeXml(value) {
    return String(value ?? '').replace(/[<>&"']/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[ch]));
  }

  function parseTex(tex) {
    const source = String(tex || '').replace(/\\dfrac/g, '\\frac').replace(/\\tfrac/g, '\\frac');
    let i = 0;

    function skipSpaces() { while (i < source.length && /\s/.test(source[i])) i += 1; }

    function readCommandName() {
      i += 1;
      if (i >= source.length) return '';
      const start = i;
      if (/[A-Za-z]/.test(source[i])) { while (i < source.length && /[A-Za-z]/.test(source[i])) i += 1; return source.slice(start, i); }
      return source[i++];
    }

    function readRawGroup(open = '{', close = '}') {
      skipSpaces();
      if (source[i] !== open) return '';
      i += 1;
      const start = i;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === open) depth += 1;
        else if (source[i] === close) depth -= 1;
        if (depth > 0) i += 1;
      }
      const out = source.slice(start, i);
      if (source[i] === close) i += 1;
      return out;
    }

    function parseSubTex(text) { return parseTex(text); }

    function splitRows(text) {
      const rows = [];
      let current = '';
      for (let p = 0; p < text.length; p += 1) {
        if (text[p] === '\\' && text[p + 1] === '\\') { rows.push(current); current = ''; p += 1; }
        else current += text[p];
      }
      rows.push(current);
      return rows;
    }

    function splitColumns(text) {
      const cols = [];
      let current = '';
      let depth = 0;
      for (let p = 0; p < text.length; p += 1) {
        if (text[p] === '{') depth += 1;
        else if (text[p] === '}') depth = Math.max(0, depth - 1);
        if (text[p] === '&' && depth === 0) { cols.push(current); current = ''; }
        else current += text[p];
      }
      cols.push(current);
      return cols;
    }

    function parseEnvironment(env, body) {
      const rows = splitRows(body).map(row => splitColumns(row).map(cell => parseSubTex(cell.trim())));
      let left = '', right = '';
      if (env === 'pmatrix') { left = '('; right = ')'; }
      else if (env === 'bmatrix') { left = '['; right = ']'; }
      else if (env === 'Bmatrix') { left = '{'; right = '}'; }
      else if (env === 'vmatrix') { left = '|'; right = '|'; }
      else if (env === 'Vmatrix') { left = '∥'; right = '∥'; }
      else if (env === 'cases') { left = '{'; right = ''; }
      return { type:'matrix', rows, left, right, env };
    }

    function parseRequiredGroup() {
      skipSpaces();
      if (source[i] === '{') { i += 1; const node = parseExpression('}'); if (source[i] === '}') i += 1; return node; }
      return parseAtom();
    }

    function parseOptionalGroup() {
      skipSpaces();
      if (source[i] !== '[') return null;
      i += 1;
      const node = parseExpression(']');
      if (source[i] === ']') i += 1;
      return node;
    }

    function parseDelimiter() {
      skipSpaces();
      if (source[i] === '\\') {
        const name = readCommandName();
        const map = { lbrace:'{', rbrace:'}', langle:'⟨', rangle:'⟩', vert:'|', Vert:'∥', lvert:'|', rvert:'|', lVert:'∥', rVert:'∥' };
        return map[name] || SYMBOLS[name] || name;
      }
      return source[i++] || '';
    }

    function parseCommand() {
      const name = readCommandName();
      if (!name) return { type:'text', value:'' };

      if (name === 'frac') return { type:'frac', num:parseRequiredGroup(), den:parseRequiredGroup() };
      if (name === 'sqrt') {
        const degree = parseOptionalGroup();
        const body = parseRequiredGroup();
        return degree ? { type:'root', degree, body } : { type:'sqrt', body };
      }
      if (name === 'text' || name === 'textrm') return { type:'text', value:readRawGroup() };
      if (name === 'operatorname') return { type:'func', value:readRawGroup() };
      if (name === 'mathrm' || name === 'mathbf' || name === 'mathit' || name === 'mathsf' || name === 'mathtt') {
        return { type:'style', style:name, body:parseRequiredGroup() };
      }
      if (name === 'left' || name === 'right') return { type:'op', value:parseDelimiter() };
      if (name === 'overline' || name === 'bar' || name === 'hat' || name === 'widehat' || name === 'vec' || name === 'dot' || name === 'ddot') {
        const accents = { overline:'¯', bar:'¯', hat:'ˆ', widehat:'ˆ', vec:'→', dot:'˙', ddot:'¨' };
        return { type:'accent', mark:accents[name], body:parseRequiredGroup() };
      }
      if (name === 'begin') {
        const env = readRawGroup();
        const endMarker = '\\end{' + env + '}';
        const end = source.indexOf(endMarker, i);
        if (end >= 0) {
          const body = source.slice(i, end);
          i = end + endMarker.length;
          return parseEnvironment(env, body);
        }
        return { type:'text', value:env };
      }
      if (name === ',' || name === ';' || name === ':' || name === '!' || name === 'quad' || name === 'qquad' || name === 'enspace' || name === 'thinspace') return { type:'space' };
      if (name === '{' || name === '}' || name === '_' || name === '%' || name === '#' || name === '&') return { type:'op', value:name };
      if (FUNCTIONS.has(name)) return { type:'func', value:name, big:BIG_OPERATORS.has(name) };
      if (SYMBOLS[name]) return { type: BIG_OPERATORS.has(name) ? 'bigop' : 'op', value:SYMBOLS[name] };
      return { type:'ident', value:name };
    }

    function parseAtom() {
      skipSpaces();
      if (i >= source.length) return { type:'text', value:'' };
      let node;
      const ch = source[i];
      if (ch === '{') { i += 1; node = parseExpression('}'); if (source[i] === '}') i += 1; }
      else if (ch === '\\') node = parseCommand();
      else if (/[0-9]/.test(ch)) {
        const start = i; while (i < source.length && /[0-9.,]/.test(source[i])) i += 1; node = { type:'number', value:source.slice(start, i) };
      } else if (/[A-Za-z]/.test(ch)) { i += 1; node = { type:'ident', value:ch }; }
      else { i += 1; node = { type:/[+\-=<>×÷±∑∫∏(),\[\]|]/.test(ch) ? 'op' : 'text', value:ch }; }

      skipSpaces();
      let sub = null, sup = null;
      while (source[i] === '_' || source[i] === '^') {
        const mode = source[i++];
        skipSpaces();
        const arg = parseRequiredGroup();
        if (mode === '_') sub = arg; else sup = arg;
        skipSpaces();
      }
      if (sub && sup) node = { type:'subsup', base:node, sub, sup };
      else if (sub) node = { type:'sub', base:node, sub };
      else if (sup) node = { type:'sup', base:node, sup };
      return node;
    }

    function parseExpression(stopChar = null) {
      const nodes = [];
      while (i < source.length) {
        skipSpaces();
        if (stopChar && source[i] === stopChar) break;
        if (i >= source.length) break;
        const node = parseAtom();
        if (node.type !== 'space' && !(node.type === 'text' && node.value === '')) nodes.push(node);
      }
      return nodes.length === 1 ? nodes[0] : { type:'row', children:nodes };
    }

    return parseExpression();
  }

  function mathMlNode(node) {
    if (!node) return '<mrow></mrow>';
    if (node.type === 'row') return '<mrow>' + node.children.map(mathMlNode).join('') + '</mrow>';
    if (node.type === 'ident') return '<mi>' + escapeXml(node.value) + '</mi>';
    if (node.type === 'func') return '<mi mathvariant="normal">' + escapeXml(node.value) + '</mi>';
    if (node.type === 'number') return '<mn>' + escapeXml(node.value) + '</mn>';
    if (node.type === 'op' || node.type === 'bigop') return '<mo>' + escapeXml(node.value) + '</mo>';
    if (node.type === 'text') return '<mtext>' + escapeXml(node.value) + '</mtext>';
    if (node.type === 'frac') return '<mfrac>' + mathMlNode(node.num) + mathMlNode(node.den) + '</mfrac>';
    if (node.type === 'sqrt') return '<msqrt>' + mathMlNode(node.body) + '</msqrt>';
    if (node.type === 'root') return '<mroot>' + mathMlNode(node.body) + mathMlNode(node.degree) + '</mroot>';
    if (node.type === 'sup') return '<msup>' + mathMlNode(node.base) + mathMlNode(node.sup) + '</msup>';
    if (node.type === 'sub') return '<msub>' + mathMlNode(node.base) + mathMlNode(node.sub) + '</msub>';
    if (node.type === 'subsup') return '<msubsup>' + mathMlNode(node.base) + mathMlNode(node.sub) + mathMlNode(node.sup) + '</msubsup>';
    if (node.type === 'accent') return '<mover accent="true">' + mathMlNode(node.body) + '<mo>' + escapeXml(node.mark) + '</mo></mover>';
    if (node.type === 'style') {
      const variant = node.style === 'mathbf' ? 'bold' : node.style === 'mathit' ? 'italic' : node.style === 'mathtt' ? 'monospace' : 'normal';
      return '<mstyle mathvariant="' + variant + '">' + mathMlNode(node.body) + '</mstyle>';
    }
    if (node.type === 'matrix') {
      const table = '<mtable>' + node.rows.map(row => '<mtr>' + row.map(cell => '<mtd>' + mathMlNode(cell) + '</mtd>').join('') + '</mtr>').join('') + '</mtable>';
      return '<mrow>' + (node.left ? '<mo fence="true">' + escapeXml(node.left) + '</mo>' : '') + table + (node.right ? '<mo fence="true">' + escapeXml(node.right) + '</mo>' : '') + '</mrow>';
    }
    return '<mtext>' + escapeXml(node.value || '') + '</mtext>';
  }

  function toMathML(tex, display = false) {
    try {
      const ast = parseTex(tex);
      return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="' + (display ? 'block' : 'inline') + '">' + mathMlNode(ast) + '</math>';
    } catch {
      return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="' + (display ? 'block' : 'inline') + '"><mtext>' + escapeXml(tex) + '</mtext></math>';
    }
  }

  function ommlRun(value) { return '<m:r><m:t>' + escapeXml(value) + '</m:t></m:r>'; }

  function ommlNode(node) {
    if (!node) return '';
    if (node.type === 'row') return node.children.map(ommlNode).join('');
    if (node.type === 'ident' || node.type === 'func' || node.type === 'number' || node.type === 'op' || node.type === 'bigop' || node.type === 'text') return ommlRun(node.value);
    if (node.type === 'frac') return '<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>' + ommlNode(node.num) + '</m:num><m:den>' + ommlNode(node.den) + '</m:den></m:f>';
    if (node.type === 'sqrt') return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' + ommlNode(node.body) + '</m:e></m:rad>';
    if (node.type === 'root') return '<m:rad><m:radPr><m:degHide m:val="0"/></m:radPr><m:deg>' + ommlNode(node.degree) + '</m:deg><m:e>' + ommlNode(node.body) + '</m:e></m:rad>';
    if (node.type === 'sup') return '<m:sSup><m:e>' + ommlNode(node.base) + '</m:e><m:sup>' + ommlNode(node.sup) + '</m:sup></m:sSup>';
    if (node.type === 'sub') return '<m:sSub><m:e>' + ommlNode(node.base) + '</m:e><m:sub>' + ommlNode(node.sub) + '</m:sub></m:sSub>';
    if (node.type === 'subsup') return '<m:sSubSup><m:e>' + ommlNode(node.base) + '</m:e><m:sub>' + ommlNode(node.sub) + '</m:sub><m:sup>' + ommlNode(node.sup) + '</m:sup></m:sSubSup>';
    if (node.type === 'accent') return '<m:acc><m:accPr><m:chr m:val="' + escapeXml(node.mark) + '"/></m:accPr><m:e>' + ommlNode(node.body) + '</m:e></m:acc>';
    if (node.type === 'style') return ommlNode(node.body);
    if (node.type === 'matrix') {
      const matrix = '<m:m>' + node.rows.map(row => '<m:mr>' + row.map(cell => '<m:e>' + ommlNode(cell) + '</m:e>').join('') + '</m:mr>').join('') + '</m:m>';
      return (node.left ? ommlRun(node.left) : '') + matrix + (node.right ? ommlRun(node.right) : '');
    }
    return ommlRun(node.value || '');
  }

  function toOmml(tex) {
    try { return '<m:oMath>' + ommlNode(parseTex(tex)) + '</m:oMath>'; }
    catch { return '<m:oMath>' + ommlRun(tex) + '</m:oMath>'; }
  }

  function toOmmlParagraph(tex) {
    try { return '<m:oMathPara><m:oMath>' + ommlNode(parseTex(tex)) + '</m:oMath></m:oMathPara>'; }
    catch { return '<m:oMathPara><m:oMath>' + ommlRun(tex) + '</m:oMath></m:oMathPara>'; }
  }

  globalThis.ChatGPTMath = Object.freeze({ parseTex, toMathML, toOmml, toOmmlParagraph });
})();
