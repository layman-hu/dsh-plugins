// DSH desktop question popup — page half. Plain script, no build, no CDN.
//
// Host protocol (lib/server.js): SSE `question` / `dismiss` / `ping`, and POST
// /answer, /dismiss, /ready, /height. Every call carries the injected token.

;(function () {
  'use strict'

  var tokenMeta = document.querySelector('meta[name="dsh-token"]')
  var token = tokenMeta ? tokenMeta.getAttribute('content') : ''

  var topbar = document.getElementById('topbar') || document.querySelector('.topbar')
  var root = document.getElementById('root')
  var empty = document.getElementById('empty')
  var footer = document.getElementById('footer')
  var submitButton = document.getElementById('submit')
  var skipButton = document.getElementById('skip')
  var closeButton = document.getElementById('close')
  var timerLabel = document.getElementById('timer')
  var toast = document.getElementById('toast')
  var hint = document.getElementById('hint')

  var state = {
    current: null,
    selections: new Map(),
    customs: new Map(),
    activeQuestionId: null,
    submitting: false,
    countdown: null,
    remainingMs: undefined,
    source: null
  }

  function url(path) {
    return path + '?token=' + encodeURIComponent(token)
  }

  function post(path, body) {
    return fetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      keepalive: true
    }).catch(function () { return null })
  }

  function showToast(message) {
    toast.textContent = message
    toast.hidden = false
    setTimeout(function () { toast.hidden = true }, 2600)
  }

  // ---------- rendering ------------------------------------------------------

  function optionMark(selected) {
    return selected ? '✓' : ''
  }

  function buildCard(question) {
    var card = document.createElement('section')
    card.className = 'card'
    card.dataset.id = question.id

    var head = document.createElement('div')
    head.className = 'card-head'
    if (question.header) {
      var chip = document.createElement('span')
      chip.className = 'chip'
      chip.textContent = question.header
      head.appendChild(chip)
    }
    if (question.multiSelect === true) {
      var multi = document.createElement('span')
      multi.className = 'multi'
      multi.textContent = '可多选'
      head.appendChild(multi)
    }
    if (head.childNodes.length > 0) card.appendChild(head)

    var title = document.createElement('p')
    title.className = 'question'
    title.textContent = question.question
    card.appendChild(title)

    if (question.detail) {
      var detail = document.createElement('p')
      detail.className = 'detail'
      detail.textContent = question.detail
      card.appendChild(detail)
    }

    var options = question.options || []
    if (options.length > 0) {
      var list = document.createElement('div')
      list.className = 'options'
      options.forEach(function (option, index) {
        var button = document.createElement('button')
        button.type = 'button'
        button.className = 'option'
        button.dataset.multi = question.multiSelect === true ? 'true' : 'false'
        button.dataset.label = option.label
        button.dataset.index = String(index)
        var selected = selectedLabels(question.id).has(option.label)
        if (selected) button.classList.add('selected')

        var mark = document.createElement('span')
        mark.className = 'mark'
        mark.textContent = optionMark(selected)
        button.appendChild(mark)

        var texts = document.createElement('span')
        texts.className = 'texts'
        var label = document.createElement('span')
        label.className = 'label'
        label.textContent = option.label
        texts.appendChild(label)
        if (option.description) {
          var desc = document.createElement('span')
          desc.className = 'desc'
          desc.textContent = option.description
          texts.appendChild(desc)
        }
        button.appendChild(texts)
        button.addEventListener('click', function () {
          state.activeQuestionId = question.id
          toggleOption(question, option.label)
        })
        list.appendChild(button)
      })
      card.appendChild(list)
    }

    var customRow = document.createElement('div')
    customRow.className = 'custom'
    var input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '其他：输入自定义回答'
    input.value = state.customs.get(question.id) || ''
    input.addEventListener('input', function () {
      var value = input.value
      if (value.trim().length === 0) state.customs.delete(question.id)
      else state.customs.set(question.id, value)
      updateSubmitState()
      reportHeight()
    })
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    })
    customRow.appendChild(input)
    card.appendChild(customRow)

    card.addEventListener('mouseenter', function () { state.activeQuestionId = question.id })
    return card
  }

  function render() {
    var current = state.current
    root.textContent = ''
    if (current === null) {
      var placeholder = document.createElement('p')
      placeholder.className = 'empty'
      placeholder.textContent = '等待提问…'
      root.appendChild(placeholder)
      footer.hidden = true
      return
    }
    footer.hidden = false
    current.questions.forEach(function (question) {
      root.appendChild(buildCard(question))
    })
    updateSubmitState()
    reportHeight()
  }

  function selectedLabels(id) {
    var set = state.selections.get(id)
    return set instanceof Set ? set : new Set()
  }

  function toggleOption(question, label) {
    var set = selectedLabels(question.id)
    var next = new Set(set)
    if (next.has(label)) {
      next.delete(label)
    } else if (question.multiSelect === true) {
      next.add(label)
    } else {
      next.clear()
      next.add(label)
    }
    state.selections.set(question.id, next)
    refreshOptionRow(question.id)
    updateSubmitState()
  }

  function refreshOptionRow(questionId) {
    var card = root.querySelector('.card[data-id="' + cssEscape(questionId) + '"]')
    if (card === null) return
    var selected = selectedLabels(questionId)
    Array.prototype.forEach.call(card.querySelectorAll('.option'), function (button) {
      var isSelected = selected.has(button.dataset.label)
      button.classList.toggle('selected', isSelected)
      var mark = button.querySelector('.mark')
      if (mark !== null) mark.textContent = optionMark(isSelected)
    })
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
    return String(value).replace(/["\\]/g, '\\$&')
  }

  function hasAnyDraft() {
    if (state.current === null) return false
    return state.current.questions.some(function (question) {
      return selectedLabels(question.id).size > 0 || Boolean(state.customs.get(question.id))
    })
  }

  function updateSubmitState() {
    submitButton.disabled = state.current === null || state.submitting || !hasAnyDraft()
  }

  // ---------- height reporting ----------------------------------------------

  function reportHeight() {
    var height = topbar.offsetHeight + root.scrollHeight + (footer.hidden ? 0 : footer.offsetHeight) + 2
    post('/height', { height: Math.ceil(height) })
  }

  // ---------- countdown ------------------------------------------------------

  function startTimer(remainingMs) {
    stopTimer()
    if (remainingMs === undefined || remainingMs === null) {
      if (state.current !== null) {
        timerLabel.hidden = false
        timerLabel.textContent = '限时'
      }
      return
    }
    state.remainingMs = remainingMs
    state.deadline = Date.now() + remainingMs
    timerLabel.hidden = false
    tickTimer()
    state.countdown = setInterval(tickTimer, 250)
  }

  function tickTimer() {
    var left = Math.max(0, state.deadline - Date.now())
    timerLabel.textContent = '剩余 ' + String(Math.ceil(left / 1000)) + 's'
    if (left <= 0) stopTimer()
  }

  function stopTimer() {
    if (state.countdown !== null) clearInterval(state.countdown)
    state.countdown = null
    timerLabel.hidden = true
  }

  // ---------- answers --------------------------------------------------------

  function buildAnswers(forceSkip) {
    return state.current.questions.map(function (question) {
      if (forceSkip === true) return { id: question.id, selected: [] }
      var selected = Array.from(selectedLabels(question.id))
      var custom = state.customs.get(question.id)
      var answer = { id: question.id, selected: selected }
      var trimmed = typeof custom === 'string' ? custom.trim() : ''
      if (trimmed.length > 0) answer.custom = trimmed
      return answer
    })
  }

  function submit(forceSkip) {
    if (state.current === null || state.submitting) return
    state.submitting = true
    updateSubmitState()
    var body = { answers: buildAnswers(forceSkip === true) }
    post('/answer', body).then(function (response) {
      if (response !== null && response.status === 200) {
        state.submitting = false
        footer.hidden = true
        return
      }
      state.submitting = false
      updateSubmitState()
      showToast('提交失败，请重试或直接在 DSH 界面作答')
    })
  }

  function dismiss() {
    post('/dismiss', {})
    stopTimer()
    state.current = null
    state.submitting = false
    render()
    hint.textContent = '已关闭；仍可在 DSH 界面作答'
  }

  function applyQuestion(payload) {
    state.current = {
      seq: payload.seq,
      callId: payload.callId,
      questions: Array.isArray(payload.questions) ? payload.questions : []
    }
    state.selections = new Map()
    state.customs = new Map()
    state.submitting = false
    state.activeQuestionId = state.current.questions.length > 0 ? state.current.questions[0].id : null
    document.title = 'DSH · 需要你的选择'
    render()
    startTimer(payload.remainingMs)
  }

  function clearQuestion() {
    state.current = null
    state.selections = new Map()
    state.customs = new Map()
    state.submitting = false
    stopTimer()
    render()
    hint.textContent = '1-9 选择 · Enter 提交 · Esc 关闭'
  }

  // ---------- keyboard -------------------------------------------------------

  function activeQuestion() {
    if (state.current === null) return null
    var list = state.current.questions
    for (var index = 0; index < list.length; index += 1) {
      if (list[index].id === state.activeQuestionId) return list[index]
    }
    return list.length > 0 ? list[0] : null
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
      return
    }
    if (event.key === 'Enter') {
      var target = event.target
      if (target !== null && target.tagName === 'INPUT') return
      event.preventDefault()
      submit(false)
      return
    }
    if (/^[1-9]$/.test(event.key)) {
      var question = activeQuestion()
      if (question === null) return
      var options = question.options || []
      var index = Number(event.key) - 1
      if (index >= options.length) return
      event.preventDefault()
      state.activeQuestionId = question.id
      toggleOption(question, options[index].label)
    }
  })

  closeButton.addEventListener('click', dismiss)
  skipButton.addEventListener('click', function () { submit(true) })
  submitButton.addEventListener('click', function () { submit(false) })

  // Closing the Edge app window must not look like an answer.
  window.addEventListener('beforeunload', function () {
    try {
      if (token.length > 0) navigator.sendBeacon(url('/dismiss'), new Blob(['{}'], { type: 'application/json' }))
    } catch (error) {
      // The host may already be gone; nothing to do.
    }
  })

  // ---------- SSE ------------------------------------------------------------

  function connect() {
    var source = new EventSource(url('/events'))
    state.source = source
    source.addEventListener('open', function () {
      post('/ready', {})
      reportHeight()
    })
    source.addEventListener('question', function (event) {
      var payload
      try {
        payload = JSON.parse(event.data)
      } catch (error) {
        return
      }
      applyQuestion(payload)
    })
    // The host announces the native window state; tests and the UI use it to know
    // that the popup is actually on screen (document.visibilityState stays
    // "hidden" for a non-activated Chromium app window).
    source.addEventListener('shown', function () {
      document.body.dataset.window = 'shown'
    })
    source.addEventListener('hidden', function () {
      document.body.dataset.window = 'hidden'
    })
    source.addEventListener('dismiss', function () {
      clearQuestion()
    })
    source.addEventListener('error', function () {
      // EventSource retries by itself; the host keeps the last question for a
      // reconnecting page and replays it on connect.
    })
  }

  render()
  connect()
})()
