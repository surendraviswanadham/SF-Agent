/**
 * Salesforce Agentforce ChatGPT-Style UI Bridge Controller
 */

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const emptyState = document.getElementById('empty-state');
    const messageList = document.getElementById('message-list');
    const quickRepliesContainer = document.getElementById('quick-replies-container');
    const clearSessionBtn = document.getElementById('clear-session-btn');
    const chatWorkspace = document.querySelector('.chat-workspace');

    // State Variables
    let localMessages = [];
    let isInitialized = false;
    let isThinking = false;
    let hasLaunched = false;

    // Helper: Traverse Shadow DOM recursively to find all matching elements
    function pierceShadowDOMAll(root, selector, results = []) {
        if (!root) return results;

        // Find matches in current scope
        if (root.querySelectorAll) {
            const matches = root.querySelectorAll(selector);
            matches.forEach(match => {
                if (!results.includes(match)) {
                    results.push(match);
                }
            });
        }

        // Check inside all children with shadow roots
        const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
        children.forEach(child => {
            if (child.shadowRoot) {
                pierceShadowDOMAll(child.shadowRoot, selector, results);
            }
        });

        return results;
    }

    // Helper: Find first matching element in shadow DOM
    function pierceShadowDOM(root, selector) {
        if (!root) return null;
        if (root.querySelector) {
            const found = root.querySelector(selector);
            if (found) return found;
        }

        const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.shadowRoot) {
                const foundInShadow = pierceShadowDOM(child.shadowRoot, selector);
                if (foundInShadow) return foundInShadow;
            }
        }
        return null;
    }

    // Textarea Auto-resizing & Send Button State
    chatInput.addEventListener('input', () => {
        // Auto resize height
        chatInput.style.height = 'auto';
        chatInput.style.height = (chatInput.scrollHeight) + 'px';
        
        // Enable/Disable send button
        sendBtn.disabled = !chatInput.value.trim();
    });

    // Handle Keyboard Enter Key to Submit
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (chatInput.value.trim()) {
                submitUserMessage(chatInput.value.trim());
            }
        }
    });

    // Handle Form Submit
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (chatInput.value.trim()) {
            submitUserMessage(chatInput.value.trim());
        }
    });

    // Handle Reset Chat Button Click
    clearSessionBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to reset the conversation history?')) {
            clearSalesforceSession();
        }
    });

    // Handle Suggestion Cards on Welcome Screen
    document.querySelectorAll('.suggestion-card').forEach(card => {
        card.addEventListener('click', () => {
            const promptText = card.getAttribute('data-prompt');
            if (promptText) {
                submitUserMessage(promptText);
            }
        });
    });

    // Safely launch Salesforce Chat session if available
    function tryLaunchSalesforceChat() {
        if (hasLaunched) return Promise.resolve();

        if (window.embeddedservice_bootstrap && 
            embeddedservice_bootstrap.utilAPI && 
            typeof embeddedservice_bootstrap.utilAPI.launchChat === 'function') {
            
            console.log('Attempting to launch Salesforce chat...');
            return embeddedservice_bootstrap.utilAPI.launchChat()
                .then(() => {
                    console.log('Salesforce chat launched successfully.');
                    hasLaunched = true;
                    isInitialized = true;
                    syncWithSalesforceDOM();
                })
                .catch(err => {
                    console.warn('Salesforce chat launch notice/error:', err);
                    isInitialized = true;
                });
        }
        return Promise.reject(new Error('Salesforce utilAPI not ready'));
    }

    // Dynamic helper to resolve Salesforce MIAW component root in DOM
    function getSalesforceTarget() {
        return document.querySelector('embedded-messaging-container, embedded-messaging-conversation-button, [class*="embeddedMessaging"]') || document.getElementById('salesforce-container') || document.body;
    }

    // Fallback: Send message by setting value on hidden Salesforce textarea
    function fallbackSendToSalesforceDOM(text) {
        const salesforceTarget = getSalesforceTarget();
        if (!salesforceTarget) return false;

        const textarea = pierceShadowDOM(salesforceTarget, 'textarea, [contenteditable="true"]');
        const sendBtn = pierceShadowDOM(salesforceTarget, 'button[aria-label*="Send"], button.send-button, [class*="send-button"], button[type="submit"]');

        if (textarea) {
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));

            if (sendBtn) {
                sendBtn.click();
                return true;
            } else {
                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                return true;
            }
        }
        return false;
    }

    // Helper to wait for Salesforce MIAW SDK to finish loading asynchronously
    function waitForSalesforceSDK(maxWaitMs = 10000) {
        return new Promise((resolve) => {
            if (window.embeddedservice_bootstrap && 
                embeddedservice_bootstrap.utilAPI && 
                typeof embeddedservice_bootstrap.utilAPI.launchChat === 'function') {
                resolve(true);
                return;
            }
            
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (window.embeddedservice_bootstrap && 
                    embeddedservice_bootstrap.utilAPI && 
                    typeof embeddedservice_bootstrap.utilAPI.launchChat === 'function') {
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (Date.now() - startTime >= maxWaitMs) {
                    clearInterval(checkInterval);
                    resolve(false);
                }
            }, 150);
        });
    }

    // Submit User Message to Salesforce
    async function submitUserMessage(text) {
        if (!text) return;

        // Reset input state
        chatInput.value = '';
        chatInput.style.height = 'auto';
        sendBtn.disabled = true;

        // Add user message to local state immediately for instant feedback
        const lastMsg = localMessages[localMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'User' || lastMsg.text !== text) {
            localMessages.push({ role: 'User', text: text });
            renderMessages([]);
        }

        // Set local typing indicator state immediately
        isThinking = true;
        updateTypingIndicator();

        // 1. Wait for SDK to finish background initialization if needed (up to 10s)
        const isSDKReady = await waitForSalesforceSDK(10000);

        // 2. Ensure Salesforce chat is launched
        if (isSDKReady && !hasLaunched) {
            try {
                await tryLaunchSalesforceChat();
            } catch (e) {
                console.warn('Launch attempt during submit:', e);
            }
        }

        // 3. Send via MIAW utilAPI
        if (window.embeddedservice_bootstrap && 
            embeddedservice_bootstrap.utilAPI && 
            typeof embeddedservice_bootstrap.utilAPI.sendTextMessage === 'function') {
            
            try {
                await embeddedservice_bootstrap.utilAPI.sendTextMessage(text);
                console.log('Message sent to Salesforce successfully.');
                setTimeout(syncWithSalesforceDOM, 200);
                return;
            } catch (err) {
                console.warn('sendTextMessage failed, trying DOM fallback:', err);
            }
        }

        // 4. DOM Fallback
        if (fallbackSendToSalesforceDOM(text)) {
            console.log('Message sent to Salesforce via DOM fallback.');
            setTimeout(syncWithSalesforceDOM, 200);
            return;
        }

        // 5. Fallback error message if SDK failed to load after timeout
        console.error('Salesforce Embedded Messaging SDK configuration failed to load.');
        isThinking = false;
        addSystemErrorMessage('Unable to connect to Salesforce Agent: Please verify setup and network connectivity.');
    }

    // Add visual system error bubble
    function addSystemErrorMessage(text) {
        isThinking = false;
        updateTypingIndicator();
        
        emptyState.classList.add('hidden');
        messageList.classList.remove('hidden');

        const errorHtml = `
            <div class="message-wrapper ai">
                <div class="ai-avatar">✨</div>
                <div class="message-content">
                    <div class="message-bubble" style="color: #ef4444; font-weight: 500;">
                        ${text}
                    </div>
                </div>
            </div>
        `;
        messageList.insertAdjacentHTML('beforeend', errorHtml);
        scrollToBottom();
    }

    // Clear Salesforce Session programmatically
    function clearSalesforceSession() {
        // Clear local state
        localMessages = [];
        messageList.innerHTML = '';
        messageList.classList.add('hidden');
        quickRepliesContainer.classList.add('hidden');
        quickRepliesContainer.innerHTML = '';
        emptyState.classList.remove('hidden');
        isThinking = false;
        updateTypingIndicator();

        // Execute Salesforce SDK resets
        try {
            if (window.embeddedservice_bootstrap) {
                if (embeddedservice_bootstrap.userVerificationAPI && 
                    typeof embeddedservice_bootstrap.userVerificationAPI.clearSession === 'function') {
                    embeddedservice_bootstrap.userVerificationAPI.clearSession();
                    console.log('Salesforce session cleared (userVerificationAPI).');
                } else if (embeddedservice_bootstrap.utilAPI && 
                           typeof embeddedservice_bootstrap.utilAPI.clearSession === 'function') {
                    embeddedservice_bootstrap.utilAPI.clearSession();
                    console.log('Salesforce session cleared (utilAPI).');
                } else {
                    console.warn('Salesforce session clearing API not found. Performing storage fallback.');
                    sessionStorage.clear();
                    localStorage.clear();
                }
            }
        } catch (e) {
            console.error('Failed to clear Salesforce session programmatically:', e);
        }

        // Reload page to reinitialize a clean session
        setTimeout(() => {
            window.location.reload();
        }, 800);
    }

    // Zero-dependency Markdown, List, & Table Parser
    function parseMarkdown(text) {
        if (!text) return '';

        // Escape HTML to prevent injection
        let safeText = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Parse markdown tables first before split lines
        const tableRegex = /((?:\|[^\n]*\|(?:\r?\n)?)+)/g;
        safeText = safeText.replace(tableRegex, (match) => {
            const lines = match.trim().split('\n');
            if (lines.length < 2) return match;

            // Verify separator row (e.g. |---|---|)
            const hasSeparator = lines[1].includes('-') && lines[1].includes('|');
            if (!hasSeparator) return match;

            let tableHtml = '<div class="table-container"><table>';

            // Headers
            const headers = lines[0].split('|').map(s => s.trim()).filter((s, i, arr) => i > 0 && i < arr.length - 1);
            tableHtml += '<thead><tr>';
            headers.forEach(h => {
                tableHtml += `<th>${h}</th>`;
            });
            tableHtml += '</tr></thead><tbody>';

            // Rows
            for (let i = 2; i < lines.length; i++) {
                const cells = lines[i].split('|').map(s => s.trim()).filter((s, i, arr) => i > 0 && i < arr.length - 1);
                tableHtml += '<tr>';
                cells.forEach(c => {
                    tableHtml += `<td>${c}</td>`;
                });
                tableHtml += '</tr>';
            }

            tableHtml += '</tbody></table></div>';
            return tableHtml;
        });

        // Bold (**text**)
        safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        // Italic (*text*)
        safeText = safeText.replace(/\*(.*?)\*/g, '<em>$1</em>');
        // Inline code (`code`)
        safeText = safeText.replace(/`(.*?)`/g, '<code>$1</code>');
        // Code Blocks (```code```)
        safeText = safeText.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

        // Split lines and parse list tags vs paragraphs
        const lines = safeText.split('\n');
        let inList = false;
        let inOrderedList = false;
        let parsedLines = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Skip lines already formatted by table parsing
            if (trimmed.startsWith('<div class="table-container">') || 
                trimmed.startsWith('</table></div>') || 
                trimmed.startsWith('<tr>') || 
                trimmed.startsWith('<td>') || 
                trimmed.startsWith('<th>') || 
                trimmed.startsWith('<thead>') || 
                trimmed.startsWith('<tbody>') ||
                trimmed.startsWith('</tr>') ||
                trimmed.startsWith('</thead>') ||
                trimmed.startsWith('</tbody>')) {
                parsedLines.push(line);
                continue;
            }

            if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                if (!inList) {
                    if (inOrderedList) {
                        parsedLines.push('</ol>');
                        inOrderedList = false;
                    }
                    parsedLines.push('<ul>');
                    inList = true;
                }
                parsedLines.push(`<li>${trimmed.substring(2)}</li>`);
            } else if (/^\d+\.\s/.test(trimmed)) {
                if (!inOrderedList) {
                    if (inList) {
                        parsedLines.push('</ul>');
                        inList = false;
                    }
                    parsedLines.push('<ol>');
                    inOrderedList = true;
                }
                const content = trimmed.replace(/^\d+\.\s/, '');
                parsedLines.push(`<li>${content}</li>`);
            } else {
                if (inList) {
                    parsedLines.push('</ul>');
                    inList = false;
                }
                if (inOrderedList) {
                    parsedLines.push('</ol>');
                    inOrderedList = false;
                }

                if (trimmed) {
                    if (trimmed.startsWith('<h') || trimmed.startsWith('<div') || trimmed.startsWith('<table')) {
                        parsedLines.push(line);
                    } else {
                        parsedLines.push(`<p>${line}</p>`);
                    }
                } else {
                    parsedLines.push('');
                }
            }
        }

        if (inList) parsedLines.push('</ul>');
        if (inOrderedList) parsedLines.push('</ol>');

        return parsedLines.join('\n');
    }

    // Scroll chat area to the bottom
    function scrollToBottom() {
        setTimeout(() => {
            chatWorkspace.scrollTop = chatWorkspace.scrollHeight;
        }, 50);
    }

    // Scan the Salesforce hidden widget DOM, extract messages, choices, cards, and update local state
    function syncWithSalesforceDOM() {
        const salesforceContainer = getSalesforceTarget();
        if (!salesforceContainer) return;

        // 1. Traverse and find all message blocks
        // We look for elements that represent the message text. Typically lightning-formatted-rich-text, lightning-formatted-text, etc.
        const textElements = pierceShadowDOMAll(salesforceContainer, 'lightning-formatted-rich-text, lightning-formatted-text, .embedded-messaging-message-content, [class*="message-bubble"]');
        
        let newMessages = [];
        let seenTexts = new Set(); // Prevent duplicates on the same node level

        textElements.forEach(el => {
            const text = (el.textContent || el.innerText || '').trim();
            if (!text) return;

            // Deduplicate matching inner tags
            if (seenTexts.has(text)) return;
            seenTexts.add(text);

            // Determine if user or agent by climbing parents
            let role = 'Agent';
            let current = el;
            while (current && current.id !== 'salesforce-container') {
                const classList = current.classList || [];
                const tagName = current.tagName || '';

                if (classList.contains('EndUser') || 
                    classList.contains('user') || 
                    classList.contains('outgoing') || 
                    tagName.includes('USER') || 
                    tagName.includes('OUTGOING') ||
                    (current.getAttribute && current.getAttribute('class') && current.getAttribute('class').includes('outgoing'))) {
                    role = 'User';
                    break;
                }
                if (classList.contains('Agent') || 
                    classList.contains('Chatbot') || 
                    classList.contains('bot') || 
                    classList.contains('incoming') || 
                    tagName.includes('AGENT') || 
                    tagName.includes('BOT') || 
                    tagName.includes('INCOMING')) {
                    role = 'Agent';
                    break;
                }
                // Traverse shadow hosts
                current = current.parentElement || (current.getRootNode && current.getRootNode().host);
            }

            newMessages.push({
                role: role,
                text: text,
                originalElement: el
            });
        });

        // 2. Scan for Salesforce Records Cards dynamically
        const recordCards = [];
        const sldsCards = pierceShadowDOMAll(salesforceContainer, '.slds-card, lightning-card, [class*="record-card"]');
        
        sldsCards.forEach(card => {
            // Title
            const titleEl = card.querySelector('[class*="title"], [class*="header"], h2, h3');
            const title = titleEl ? titleEl.textContent.trim() : 'Record Details';

            // Fields (e.g. key-value tables, grid layouts)
            const fields = [];
            const labels = card.querySelectorAll('.slds-form-element__label, label, [class*="label"]');
            const values = card.querySelectorAll('.slds-form-element__control, .value, [class*="value"]');

            for (let i = 0; i < Math.min(labels.length, values.length); i++) {
                const label = labels[i].textContent.trim();
                const value = values[i].textContent.trim();
                if (label && value && label !== value) {
                    fields.push({ label, value });
                }
            }

            // Buttons inside the record card
            const actionButtons = [];
            const btns = card.querySelectorAll('button, a, [role="button"]');
            btns.forEach(btn => {
                const btnText = btn.textContent.trim();
                if (btnText) {
                    actionButtons.push({
                        text: btnText,
                        element: btn
                    });
                }
            });

            recordCards.push({
                title: title,
                fields: fields,
                buttons: actionButtons,
                originalElement: card
            });
        });

        // 3. Scan for Suggested Choice Buttons (Quick Replies)
        // Usually buttons or custom choice pills rendered in the chat panel
        const choiceButtons = [];
        const allButtons = pierceShadowDOMAll(salesforceContainer, 'button, [role="button"], [class*="choice-button"]');
        
        allButtons.forEach(btn => {
            const btnText = (btn.textContent || btn.innerText || '').trim();
            if (!btnText) return;

            // Exclude system buttons (Send, Close, Minimize, File attachment)
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const classList = btn.className || '';
            const isSystem = ariaLabel.toLowerCase().includes('close') || 
                             ariaLabel.toLowerCase().includes('minimize') || 
                             ariaLabel.toLowerCase().includes('send') || 
                             ariaLabel.toLowerCase().includes('attachment') ||
                             classList.includes('close') || 
                             classList.includes('minimize') || 
                             classList.includes('send') ||
                             btnText.length > 50; // Too long for a button

            if (!isSystem) {
                choiceButtons.push({
                    text: btnText,
                    element: btn
                });
            }
        });

        // 4. Scan for Typing/Thinking indicator inside Salesforce
        const sfTypingIndicator = pierceShadowDOM(salesforceContainer, 'embedded-messaging-typing-indicator, .typing-indicator, [class*="typing"]');
        if (sfTypingIndicator) {
            isThinking = true;
        } else {
            // Fallback: If we got a new message from the agent, stop the thinking state
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'Agent') {
                isThinking = false;
            }
        }

        // 5. Safely merge scraped Salesforce messages into local state without erasing user messages
        let hasNewMessage = false;
        newMessages.forEach(msg => {
            const exists = localMessages.some(m => m.role === msg.role && m.text === msg.text);
            if (!exists) {
                localMessages.push({ role: msg.role, text: msg.text });
                hasNewMessage = true;
                if (msg.role === 'Agent') {
                    isThinking = false;
                }
            }
        });

        if (hasNewMessage || recordCards.length > 0) {
            renderMessages(recordCards);
        }

        // Render Quick Replies
        renderQuickReplies(choiceButtons);
        
        // Render Typing state
        updateTypingIndicator();
    }

    // Render Messages & Salesforce Record Cards
    function renderMessages(recordCards) {
        if (localMessages.length === 0) {
            emptyState.classList.remove('hidden');
            messageList.classList.add('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        messageList.classList.remove('hidden');
        messageList.innerHTML = '';

        localMessages.forEach((msg, index) => {
            const isUser = msg.role === 'User';
            let formattedContent = '';

            if (isUser) {
                formattedContent = `
                    <div class="message-wrapper user">
                        <div class="message-bubble">${msg.text}</div>
                    </div>
                `;
            } else {
                // Parse markdown layout
                const htmlContent = parseMarkdown(msg.text);
                
                // Check if this AI response contains record cards
                let cardsHtml = '';
                
                // Match cards to messages. In this model, if it's the last message or contains record identifiers, we display the cards below it
                if (index === localMessages.length - 1) {
                    recordCards.forEach((card, cIndex) => {
                        let fieldsHtml = '';
                        card.fields.forEach(f => {
                            fieldsHtml += `
                                <div class="record-field">
                                    <span class="field-label">${f.label}</span>
                                    <span class="field-value">${f.value}</span>
                                </div>
                            `;
                        });

                        let btnsHtml = '';
                        card.buttons.forEach((b, bIndex) => {
                            btnsHtml += `
                                <button class="record-btn ${bIndex === 0 ? 'primary' : ''}" data-card-index="${cIndex}" data-btn-index="${bIndex}">
                                    ${b.text}
                                </button>
                            `;
                        });

                        cardsHtml += `
                            <div class="salesforce-record-card">
                                <div class="record-card-header">
                                    <span class="record-title">${card.title}</span>
                                    <span class="record-status-badge">Active</span>
                                </div>
                                <div class="record-fields">
                                    ${fieldsHtml}
                                </div>
                                <div class="record-actions">
                                    ${btnsHtml}
                                </div>
                            </div>
                        `;
                    });
                }

                formattedContent = `
                    <div class="message-wrapper ai">
                        <div class="ai-avatar">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/>
                            </svg>
                        </div>
                        <div class="message-content">
                            <div class="message-bubble">${htmlContent}</div>
                            ${cardsHtml}
                        </div>
                    </div>
                `;
            }

            messageList.insertAdjacentHTML('beforeend', formattedContent);
        });

        // Add Event Listeners for Record Action Buttons
        document.querySelectorAll('.record-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const cardIndex = parseInt(btn.getAttribute('data-card-index'));
                const btnIndex = parseInt(btn.getAttribute('data-btn-index'));
                
                // Scrape cards again to get button references
                const sfContainer = document.getElementById('salesforce-container');
                const sldsCards = pierceShadowDOMAll(sfContainer, '.slds-card, lightning-card, [class*="record-card"]');
                if (sldsCards[cardIndex]) {
                    const cardBtns = sldsCards[cardIndex].querySelectorAll('button, a, [role="button"]');
                    if (cardBtns[btnIndex]) {
                        // Click original element inside Salesforce
                        cardBtns[btnIndex].click();
                        console.log(`Programmatically clicked Salesforce card action: ${btn.textContent.trim()}`);
                        
                        // Set loading state
                        isThinking = true;
                        updateTypingIndicator();
                    }
                }
            });
        });

        scrollToBottom();
    }

    // Render Quick Replies (Suggested Actions)
    function renderQuickReplies(choices) {
        if (choices.length === 0 || isThinking) {
            quickRepliesContainer.classList.add('hidden');
            quickRepliesContainer.innerHTML = '';
            return;
        }

        quickRepliesContainer.classList.remove('hidden');
        quickRepliesContainer.innerHTML = '';

        choices.forEach((choice, index) => {
            const btn = document.createElement('button');
            btn.className = 'quick-reply-btn';
            btn.textContent = choice.text;
            btn.addEventListener('click', () => {
                // Triggers clicking the actual choice in Salesforce DOM
                if (choice.element) {
                    choice.element.click();
                    console.log(`Programmatically clicked Salesforce choice: ${choice.text}`);
                    
                    // Mark thinking/typing state
                    isThinking = true;
                    updateTypingIndicator();
                    
                    // Hide quick replies immediately
                    quickRepliesContainer.classList.add('hidden');
                } else {
                    // Fallback to sending text if element not found
                    submitUserMessage(choice.text);
                }
            });
            quickRepliesContainer.appendChild(btn);
        });
    }

    // Manage Typing Indicator Visibility
    function updateTypingIndicator() {
        const existingTyping = document.querySelector('.typing-wrapper');
        
        if (isThinking) {
            if (!existingTyping) {
                const typingHtml = `
                    <div class="typing-wrapper">
                        <div class="typing-indicator">
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                        </div>
                    </div>
                `;
                // Append typing indicator inside scroll workspace but outside list/replies
                if (messageList.classList.contains('hidden')) {
                    emptyState.classList.add('hidden');
                    messageList.classList.remove('hidden');
                }
                messageList.insertAdjacentHTML('beforeend', typingHtml);
                scrollToBottom();
            }
        } else {
            if (existingTyping) {
                existingTyping.remove();
            }
        }
    }

    // Register Salesforce SDK Events to trigger immediate synchronization
    function handleSalesforceMessageEvent(event) {
        console.log('MIAW Event received:', event.type, JSON.stringify(event.detail));
        
        if (event.detail) {
            const detail = event.detail;
            const entry = detail.conversationEntry || detail.entry || detail;
            const senderRole = entry.sender?.role || detail.senderRole || detail.role || entry.role;
            
            let role = 'Agent';
            if (senderRole === 'User' || senderRole === 'EndUser') {
                role = 'User';
            } else if (senderRole === 'Agent' || senderRole === 'Chatbot') {
                role = 'Agent';
                isThinking = false;
            }
            
            // Extract text from all potential MIAW payload paths
            let text = '';
            const abstractMessage = entry.entryPayload?.abstractMessage || detail.entryPayload?.abstractMessage;
            const staticContent = abstractMessage?.staticContent;
            
            if (staticContent?.text) {
                text = staticContent.text;
            } else if (staticContent?.caption) {
                text = staticContent.caption;
            } else if (staticContent?.title) {
                text = staticContent.title;
            } else if (typeof entry.content === 'string') {
                text = entry.content;
            } else if (typeof entry.text === 'string') {
                text = entry.text;
            } else if (typeof detail.text === 'string') {
                text = detail.text;
            } else if (typeof detail.content === 'string') {
                text = detail.content;
            }
            
            if (text) {
                const exists = localMessages.some(m => m.role === role && m.text === text);
                if (!exists) {
                    localMessages.push({ role, text });
                    renderMessages([]);
                }
            }
        }
        
        updateTypingIndicator();
        setTimeout(syncWithSalesforceDOM, 100);
    }

    window.addEventListener('onEmbeddedMessagingReady', () => {
        console.log('Salesforce Embedded Messaging Ready event received.');
        isInitialized = true;
        tryLaunchSalesforceChat();
    });

    window.addEventListener('onEmbeddedMessagingConversationStarted', (event) => {
        console.log('Salesforce Embedded Messaging Conversation Started:', event.detail);
        isInitialized = true;
        setTimeout(syncWithSalesforceDOM, 100);
    });

    window.addEventListener('onEmbeddedMessagingConversationEntryCreated', handleSalesforceMessageEvent);
    window.addEventListener('onEmbeddedMessagingMessageReceived', handleSalesforceMessageEvent);
    window.addEventListener('onEmbeddedMessagingMessageSent', handleSalesforceMessageEvent);
    window.addEventListener('onEmbeddedMessageSent', handleSalesforceMessageEvent);

    // Suppress default Salesforce floating chat button widget from visible screen
    function suppressSalesforceFloatingWidget() {
        const targets = document.querySelectorAll('embedded-messaging-conversation-button, embedded-messaging-container, embedded-messaging-bootstrap, .embeddedMessagingConversationButton, .embeddedMessagingContainer, [class*="embeddedMessaging"]');
        targets.forEach(el => {
            el.style.setProperty('position', 'fixed', 'important');
            el.style.setProperty('bottom', '0', 'important');
            el.style.setProperty('right', '0', 'important');
            el.style.setProperty('width', '375px', 'important');
            el.style.setProperty('height', '600px', 'important');
            el.style.setProperty('opacity', '0.001', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
            el.style.setProperty('z-index', '-1', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('display', 'block', 'important');
        });
    }

    // Immediate check on load in case onEmbeddedMessagingReady fired before listener attached
    if (window.embeddedservice_bootstrap && embeddedservice_bootstrap.utilAPI) {
        isInitialized = true;
        tryLaunchSalesforceChat();
    }

    suppressSalesforceFloatingWidget();

    // Fallback sync loop: checks the Salesforce DOM every 250ms to grab history, status updates, card renders & hide widget
    setInterval(() => {
        suppressSalesforceFloatingWidget();
        if (!hasLaunched && window.embeddedservice_bootstrap && embeddedservice_bootstrap.utilAPI) {
            tryLaunchSalesforceChat();
        }
        syncWithSalesforceDOM();
    }, 250);
});
