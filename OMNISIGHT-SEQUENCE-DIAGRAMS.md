# OmniSight — Sequence Diagrams

## Message Flows Between Actors

This document shows detailed sequence diagrams that illustrate the **order of messages and interactions** between actors in each workflow. Sequence diagrams are ideal for understanding:

- The exact order of operations
- Which actor initiates each action
- What responses are expected
- Synchronization points between actors

---

## Sequence Diagram Legend

| Symbol | Meaning |
|--------|---------|
| **→** | Synchronous message (caller waits) |
| **-->>** | Asynchronous message (caller doesn't wait) |
| **Note** | Information about the interaction |
| **alt** | Alternative paths (if/else) |
| **loop** | Repeated interactions |
| **opt** | Optional interactions |
| **par** | Parallel interactions |

---

## Scenario 1: New Employee Onboarding — Sequence

```mermaid
sequenceDiagram
    participant A as 👤 Administrator
    participant S as ⚙️ System
    participant E as 👥 Employee

    Note over A,E: === Phase 1: Employee Setup ===
    
    A->>S: Open Employees Page
    S-->>A: Display Employee List
    
    A->>S: Click Add Employee
    S-->>A: Show Employee Form
    
    A->>S: Submit Employee Details
    S->>S: Validate Data
    S->>S: Create Employee Record
    S-->>A: Confirm Employee Created
    
    Note over A,E: === Phase 2: Agent Account ===
    
    A->>S: Create Agent Account
    S->>S: Generate Credentials
    S-->>A: Show Agent Account Details
    
    A->>S: Set Agent Password
    S->>S: Hash Password
    S-->>A: Confirm Account Ready
    
    Note over A,E: === Phase 3: Agent Installation ===
    
    A->>S: Download Agent Installer
    S-->>A: Provide Installer File
    
    A->>E: Send Installer to Employee
    Note right of E: Email with installer
    
    E->>E: Download Installer
    E->>E: Run Installer
    E->>S: Agent Contacts Server
    Note left of S: HTTP POST /api/agent/discover
    
    S->>S: Validate Agent
    S->>S: Create Device Claim
    S-->>A: Notify: New Device Claim
    
    Note over A,E: === Phase 4: Device Approval ===
    
    A->>S: Open Agent Approvals
    S-->>A: Show Pending Claims
    
    A->>S: Review Device Details
    S-->>A: Display Device Info
    
    A->>S: Approve Device Claim
    S->>S: Update Device Status
    S->>S: Link Device to Employee
    S-->>A: Confirm Device Approved
    
    Note over A,E: === Phase 5: Consent & Monitoring ===
    
    A->>S: Open Consent Page
    S-->>A: Show Consent Matrix
    
    A->>S: Grant Monitoring Consent
    S->>S: Record Consent
    S-->>A: Confirm Consent Granted
    
    A->>S: Grant Screenshot Consent
    S->>S: Record Consent
    S-->>A: Confirm Consent Granted
    
    S->>S: Begin Data Collection
    S-->>A: Monitoring Active
    
    Note over A,E: === Onboarding Complete ===
```

---

## Scenario 2: Device Enrollment — Sequence

```mermaid
sequenceDiagram
    participant IT as 🔧 IT Department
    participant S as ⚙️ System
    participant A as 👤 Administrator

    Note over IT,A: === Phase 1: Device Preparation ===
    
    IT->>IT: Prepare New Device
    IT->>IT: Install OmniSight Agent
    IT->>S: Agent Starts, Contacts Server
    Note left of S: HTTP POST /api/agent/login
    
    S->>S: Validate Agent Credentials
    S-->>IT: Agent Authenticated
    
    Note over IT,A: === Phase 2: Device Discovery ===
    
    IT->>S: Agent Sends Discovery
    Note left of S: HTTP POST /api/agent/discover
    
    S->>S: Create Device Record
    S->>S: Create Device Claim (Pending)
    S-->>A: Notify: New Device Pending
    
    Note over IT,A: === Phase 3: Admin Review ===
    
    A->>S: Open Agent Approvals
    S-->>A: Show Pending Claims List
    
    A->>S: Select Device Claim
    S-->>A: Display Device Details
    Note right of A: Hostname, OS, Employee, etc.
    
    A->>A: Review Device Information
    
    alt Device is Legitimate
        A->>S: Approve Device
        S->>S: Update Device Status: Approved
        S->>S: Assign to Employee
        S->>S: Generate Agent Token
        S-->>A: Confirm: Device Approved
    else Device is Suspicious
        A->>S: Reject Device
        S->>S: Update Device Status: Rejected
        S->>S: Record Rejection Reason
        S-->>A: Confirm: Device Rejected
    end
    
    Note over IT,A: === Phase 4: Active Monitoring ===
    
    S->>S: Device Goes Online
    S->>S: Start Heartbeat Timer
    S-->>A: Device Online Status
    
    loop Every Heartbeat Interval
        IT->>S: Agent Sends Heartbeat
        Note left of S: HTTP POST /api/agent/heartbeat
        S->>S: Update Last Heartbeat
        S-->>A: Status: Online
    end
```

---

## Scenario 3: Device Offline Investigation — Sequence

```mermaid
sequenceDiagram
    participant S as ⚙️ System
    participant A as 👤 Administrator
    participant E as 👥 Employee

    Note over S,E: === Phase 1: Detection ===
    
    S->>S: Monitor Heartbeats
    S->>S: Detect Missing Heartbeat
    S->>S: Update Device Status: Offline
    S-->>A: Alert: Device Offline
    Note right of A: Notification + Dashboard badge
    
    Note over S,E: === Phase 2: Investigation ===
    
    A->>S: Open Device Details
    S-->>A: Display Device Info
    Note right of A: Last Heartbeat, Status, Employee
    
    A->>A: Analyze Last Heartbeat
    A->>A: Determine Likely Cause
    
    alt Recent Heartbeat (< 1 hour)
        Note over A: Network Issue Likely
        A->>E: Contact Employee
        Note right of E: Phone/Email call
        E-->>A: Respond to Inquiry
        E->>E: Check Network Connection
        E-->>A: Report Status
    else Older Heartbeat (1-24 hours)
        Note over A: Agent Issue Likely
        A->>A: Check Agent Service Status
        A->>E: Contact Employee
        E-->>A: Respond
        E->>E: Check Agent Service
        alt Agent Not Running
            E->>E: Restart Agent Service
        else Agent Running but Broken
            E->>E: Reinstall Agent
        end
        E-->>A: Report Resolution
    else Very Old Heartbeat (> 24 hours)
        Note over A: Device May Be Off
        A->>A: Check Device Status
        A->>E: Contact Employee
        E-->>A: Respond
        E->>E: Check Device
        E-->>A: Report Status
    end
    
    Note over S,E: === Phase 3: Resolution ===
    
    A->>A: Document Investigation
    A->>S: Update Investigation Notes
    
    S->>S: Monitor for Heartbeat
    S->>S: Detect Device Back Online
    S->>S: Update Device Status: Online
    S-->>A: Confirm: Device Online
    S-->>A: Investigation Complete
```

---

## Scenario 4: Employee Activity Review — Sequence

```mermaid
sequenceDiagram
    participant M as 👤 Manager
    participant S as ⚙️ System
    participant HR as 👥 HR Department

    Note over M,HR: === Phase 1: Initiate Review ===
    
    M->>S: Open Employees Page
    S-->>M: Display Employee List
    
    M->>S: Search/Select Employee
    S-->>M: Show Employee Results
    
    M->>S: Open Employee Detail
    S-->>M: Display Employee Profile
    
    Note over M,HR: === Phase 2: Overview Assessment ===
    
    M->>S: View Overview Tab
    S->>S: Calculate Productivity Score
    S->>S: Aggregate Period Statistics
    S-->>M: Display Overview
    Note right of M: Score, Hours, Active Days
    
    M->>M: Assess Productivity Score
    
    alt Score Acceptable (> 50)
        Note over M: Good Performance
        M->>M: Document Positive Assessment
    else Score Low (< 50)
        Note over M: Needs Attention
        M->>S: View Activity Tab
        S->>S: Query Activity Records
        S-->>M: Display Activity Timeline
        
        M->>S: View Apps & Websites Tab
        S->>S: Aggregate App Usage
        S-->>M: Display App Statistics
        
        M->>M: Analyze Activity Patterns
        M->>M: Identify Concerns
    end
    
    Note over M,HR: === Phase 3: Follow-up ===
    
    alt Issues Found
        M->>M: Document Findings
        M->>S: Create Action Item
        S-->>M: Action Item Created
        
        M->>HR: Submit Review Report
        HR-->>M: Acknowledge Report
        
        HR->>HR: Update Employee Records
        HR->>HR: Plan Training if Needed
    else No Issues
        M->>M: Document Positive Review
        M->>S: Log Review Complete
    end
    
    Note over M,HR: === Phase 4: Monitoring ===
    
    loop Weekly Check-in
        M->>S: View Progress Metrics
        S-->>M: Display Updated Stats
        M->>M: Assess Progress
    end
```

---

## Scenario 5: Management Review Meeting — Sequence

```mermaid
sequenceDiagram
    participant A as 👤 Administrator
    participant S as ⚙️ System
    participant M as 👔 Management
    participant T as 👥 Teams

    Note over A,T: === Phase 1: Preparation (Before Meeting) ===
    
    A->>S: Request Dashboard Summary
    S->>S: Aggregate Metrics
    S-->>A: Dashboard Data Ready
    
    A->>S: Request Analytics Report
    S->>S: Calculate Trends
    S->>S: Compare Departments
    S-->>A: Analytics Report Ready
    
    A->>S: Request Device Status
    S->>S: Check All Devices
    S-->>A: Device Fleet Status
    
    A->>S: Generate Productivity Report
    S->>S: Compile Report Data
    S->>S: Format Report
    S-->>A: Report Ready
    
    A->>A: Compile Summary
    A->>A: Identify Key Findings
    A->>A: Prepare Action Items
    
    Note over A,T: === Phase 2: Meeting ===
    
    M->>A: Attend Meeting
    A->>M: Present Dashboard Overview
    Note right of M: Key metrics, alerts
    
    A->>M: Present Analytics Findings
    Note right of M: Trends, comparisons
    
    A->>M: Present Device Status
    Note right of M: Online/offline, issues
    
    M->>A: Ask Questions
    A->>M: Provide Answers
    
    M->>M: Discuss Findings
    M->>M: Make Decisions
    
    Note over A,T: === Phase 3: Action Items ===
    
    M->>A: Assign Action Items
    A->>S: Create Action Items
    S->>S: Store Action Items
    S-->>A: Action Items Saved
    
    M->>A: Approve Next Steps
    A->>A: Document Decisions
    
    Note over A,T: === Phase 4: Follow-up ===
    
    A->>T: Distribute Meeting Summary
    T-->>A: Acknowledge Receipt
    
    T->>T: Implement Changes
    T->>S: Update Progress
    S-->>A: Progress Updated
    
    loop Weekly Progress Check
        A->>S: Review Action Item Status
        S-->>A: Progress Report
        A->>M: Update Management
    end
```

---

## Scenario 6: Security Alert Response — Sequence

```mermaid
sequenceDiagram
    participant SY as ⚙️ System
    participant SEC as 🔒 Security Team
    participant A as 👤 Administrator
    participant E as 👥 Employee

    Note over SY,E: === Phase 1: Alert Detection ===
    
    SY->>SY: Detect Anomaly
    SY->>SY: Analyze Severity
    SY->>SY: Generate Alert
    SY->>SEC: Send Critical Alert
    Note right of SEC: Immediate notification
    
    SY->>A: Send Alert Copy
    Note right of A: For awareness
    
    Note over SY,E: === Phase 2: Initial Response ===
    
    SEC->>SY: Acknowledge Alert
    SY->>SEC: Display Alert Details
    Note right of SEC: Type, Severity, Affected
    
    SEC->>SEC: Assess Severity Level
    
    alt Critical Severity
        SEC->>SEC: Initiate Containment
        Note right of SEC: Isolate if needed
        SEC->>A: Request Escalation
        A->>A: Review Escalation
    else High Severity
        SEC->>SEC: Begin Investigation
    else Medium/Low Severity
        SEC->>SEC: Schedule Review
    end
    
    Note over SY,E: === Phase 3: Investigation ===
    
    SEC->>SY: Request Investigation Data
    SY->>SY: Query Logs
    SY->>SY: Analyze Patterns
    SY-->>SEC: Investigation Data Ready
    
    SEC->>A: Request Employee Contact
    A->>E: Contact Employee
    Note right of E: Phone/Email
    
    E->>A: Respond to Inquiry
    E->>A: Provide Information
    A->>SEC: Forward Information
    
    SEC->>SEC: Analyze Information
    SEC->>SEC: Determine Root Cause
    
    Note over SY,E: === Phase 4: Resolution ===
    
    alt Issue Confirmed
        SEC->>A: Recommend Action
        A->>A: Approve Action
        A->>E: Instruct Corrective Action
        E->>E: Take Corrective Action
        E->>A: Confirm Resolution
        A->>SEC: Confirm Resolution
    else False Positive
        SEC->>SEC: Mark as False Positive
        SEC->>A: Report False Positive
    end
    
    SEC->>SY: Update Alert Status
    SY->>SY: Log Resolution
    SY->>SY: Archive Alert
    
    Note over SY,E: === Phase 5: Documentation ===
    
    SEC->>SEC: Document Investigation
    SEC->>A: Submit Investigation Report
    A->>A: Review Report
    A->>SY: Store Report
    SY-->>A: Report Archived
```

---

## Scenario 7: Consent Management — Sequence

```mermaid
sequenceDiagram
    participant A as 👤 Administrator
    participant S as ⚙️ System
    participant E as 👥 Employee

    Note over A,E: === Phase 1: Policy Creation ===
    
    A->>S: Open Consent Page
    S-->>A: Display Consent Matrix
    
    A->>S: Create New Policy
    S-->>A: Show Policy Form
    
    A->>S: Enter Policy Details
    Note right of A: Title, Content, Type
    
    A->>S: Save Draft Policy
    S->>S: Store Policy (Draft)
    S-->>A: Policy Saved as Draft
    
    Note over A,E: === Phase 2: Policy Publication ===
    
    A->>S: Review Policy Content
    A->>S: Publish Policy
    S->>S: Update Policy Status: Published
    S->>S: Set Effective Date
    S-->>A: Policy Published
    
    Note over A,E: === Phase 3: Consent Request ===
    
    A->>S: Request Employee Consent
    S->>S: Create Consent Record (Pending)
    S->>E: Send Consent Request
    Note right of E: Email notification
    
    Note over A,E: === Phase 4: Employee Decision ===
    
    E->>S: Open Consent Request
    S-->>E: Display Policy Content
    Note right of E: Full policy text
    
    E->>E: Review Policy
    
    alt Employee Grants Consent
        E->>S: Grant Consent
        S->>S: Update Status: Granted
        S->>S: Record Grant Timestamp
        S-->>E: Consent Confirmed
        S-->>A: Notify: Consent Granted
    else Employee Denies Consent
        E->>S: Deny Consent
        S->>S: Update Status: Denied
        S->>S: Record Deny Timestamp
        S-->>E: Denial Recorded
        S-->>A: Notify: Consent Denied
    else No Response
        Note over S: Wait Period (7 days)
        S->>E: Send Reminder
        E->>S: (Eventually responds)
    end
    
    Note over A,E: === Phase 5: Monitoring Activation ===
    
    alt Consent Granted
        S->>S: Enable Monitoring for Type
        S->>S: Begin Data Collection
        S-->>A: Monitoring Active
    else Consent Denied
        S->>S: Disable Monitoring for Type
        S->>S: Stop Data Collection
        S-->>A: Monitoring Disabled
    end
    
    Note over A,E: === Phase 6: Expiration Handling ===
    
    loop Daily Check
        S->>S: Check Consent Expirations
        alt Consent Expired
            S->>A: Notify: Consent Expired
            S->>E: Send Renewal Request
        end
    end
```

---

## Scenario 8: Report Generation — Sequence

```mermaid
sequenceDiagram
    participant A as 👤 Administrator
    participant S as ⚙️ System
    participant M as 👔 Management

    Note over A,M: === Phase 1: Report Request ===
    
    A->>S: Open Reports Page
    S-->>A: Display Report Types
    
    A->>S: Select Report Type
    S-->>A: Show Configuration Form
    
    A->>S: Set Date Range
    A->>S: Select Scope (Employee/Dept/All)
    A->>S: Choose Format (PDF/Excel/CSV)
    
    Note over A,M: === Phase 2: Report Generation ===
    
    A->>S: Generate Report
    S->>S: Query Database
    S->>S: Aggregate Metrics
    S->>S: Calculate Statistics
    S->>S: Format Report
    S->>S: Store Report Record
    S-->>A: Report Ready
    
    Note over A,M: === Phase 3: Download ===
    
    A->>S: Download Report
    S-->>A: Provide File
    Note right of A: PDF/Excel/CSV file
    
    Note over A,M: === Phase 4: Distribution ===
    
    alt Email Distribution
        A->>S: Email Report
        S->>M: Send Report Email
        Note right of M: Report attached
        M-->>S: Email Received
    else Meeting Presentation
        A->>M: Present Report
        Note right of M: In meeting
    else Archive Only
        A->>S: Archive Report
        S->>S: Store in Report Archive
    end
    
    Note over A,M: === Phase 5: Follow-up ===
    
    M->>M: Review Report Contents
    M->>M: Identify Insights
    M->>A: Provide Feedback
    A->>A: Note Feedback
    A->>S: Log Report Usage
    S->>S: Update Usage Statistics
```

---

## Cross-Scenario Message Flow Summary

### Administrator ↔ System Messages

| Message | Direction | Description |
|---------|-----------|-------------|
| Open Page | A → S | Request page load |
| Submit Form | A → S | Send form data |
| Approve/Reject | A → S | Decision action |
| Grant Consent | A → S | Consent action |
| Generate Report | A → S | Report request |
| Download File | A → S | File request |

### System → Administrator Messages

| Message | Direction | Description |
|---------|-----------|-------------|
| Display Data | S → A | Show requested data |
| Confirm Action | S → A | Action completed |
| Send Alert | S → A | Important notification |
| Report Ready | S → A | Report generated |

### Employee ↔ System Messages

| Message | Direction | Description |
|---------|-----------|-------------|
| Agent Contact | E → S | Agent connects to server |
| Heartbeat | E → S | Regular status update |
| Grant/Deny Consent | E → S | Consent decision |
| Receive Notification | S → E | System notification |

### Administrator ↔ Employee Messages

| Message | Direction | Description |
|---------|-----------|-------------|
| Send Installer | A → E | Provide software |
| Contact Employee | A → E | Reach out for info |
| Provide Info | E → A | Respond to inquiry |
| Confirm Resolution | E → A | Issue resolved |

---

## Timing Diagrams (Simplified)

### Device Enrollment Timing

```
Time ──────────────────────────────────────────────────────▶

IT:      [Prepare] [Install] [Deliver] ─────────────────────
         │         │         │
         ▼         ▼         ▼
System:  ─────────[Auth]──[Claim]──[Notify]──[Online]───────
                              │       │         │
                              ▼       ▼         ▼
Admin:   ───────────────────[Review]─[Approve]─[Monitor]────
```

### Security Alert Timing

```
Time ──────────────────────────────────────────────────────▶

System:  [Detect]─[Alert]───────────────────────────────────
         │        │
         ▼        ▼
Security:────────[Acknowledge]─[Investigate]─[Resolve]──────
                        │            │            │
                        ▼            ▼            ▼
Admin:   ────────────[Escalate]──[Oversee]──[Document]──────
                              │            │
                              ▼            ▼
Employee:────────────────────[Contact]──[Resolve]────────────
```

---

*Sequence diagrams created August 2026*
*OmniSight v1.0.0*
