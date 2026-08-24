# OmniSight — Swimlane Diagrams

## Actor Responsibilities in Workflows

This document shows detailed swimlane diagrams that clearly define **who does what** in each workflow. Each swimlane represents a different actor (Administrator, Employee, System, etc.).

---

## Scenario 1: New Employee Onboarding — Swimlane

```mermaid
flowchart TB
    subgraph Admin["👤 Administrator"]
        A1[📋 Open Employees Page]
        A2[➕ Click Add Employee]
        A3[📝 Fill Employee Details]
        A4[💾 Save Employee Record]
        A5[🔑 Create Agent Account]
        A6[🔐 Set Agent Credentials]
        A7[📦 Download Agent Installer]
        A8[📧 Send Installer to Employee]
        A9[👀 Monitor Agent Approvals]
        A10[✅ Approve Device Claim]
        A11[🔗 Assign Device to Employee]
        A12[🔒 Open Consent Page]
        A13[✅ Grant Required Consents]
    end
    
    subgraph Employee["👥 Employee"]
        E1[📧 Receive Installer]
        E2[💻 Install Agent Software]
        E3[🔐 Enter Agent Credentials]
        E4[🌐 Agent Connects to Server]
        E5[⏳ Wait for Approval]
        E6[✅ Device Approved]
    end
    
    subgraph System["⚙️ System"]
        S1[📊 Create Employee Record]
        S2[🔑 Generate Agent Account]
        S3[📡 Agent Contacts Server]
        S4[📋 Create Device Claim]
        S5[🔔 Notify Admin of Claim]
        S6[🔗 Link Device to Employee]
        S7[📊 Begin Monitoring]
        S8[💓 Start Heartbeat]
    end
    
    A1 --> A2 --> A3 --> A4
    A4 --> S1
    S1 --> A5 --> A6
    A6 --> S2
    S2 --> A7 --> A8
    A8 --> E1
    E1 --> E2 --> E3 --> E4
    E4 --> S3
    S3 --> S4
    S4 --> S5
    S5 --> A9
    A9 --> A10
    A10 --> S6
    S6 --> E6
    E6 --> A11 --> A12 --> A13
    A13 --> S7
    S7 --> S8

    style Admin fill:#e3f2fd
    style Employee fill:#e8f5e9
    style System fill:#fff3e0
```

### Responsibility Matrix

| Step | Administrator | Employee | System |
|------|---------------|----------|--------|
| 1 | Add employee record | — | Create database record |
| 2 | Create agent account | — | Generate credentials |
| 3 | Provide installer | Install agent | — |
| 4 | — | Enter credentials | Validate & connect |
| 5 | — | — | Create device claim |
| 6 | Approve device | — | Link device to employee |
| 7 | Grant consent | — | Begin monitoring |

---

## Scenario 2: Device Enrollment — Swimlane

```mermaid
flowchart TB
    subgraph Admin["👤 Administrator"]
        A1[🔔 Receive Notification]
        A2[👀 Open Agent Approvals]
        A3[📋 Review Device Details]
        A4{Device Legitimate?}
        A5[✅ Approve Device]
        A6[❌ Reject Device]
        A7[👤 Assign to Employee]
        A8[📝 Record Decision]
    end
    
    subgraph IT["🔧 IT Department"]
        I1[📦 Prepare Device]
        I2[📦 Install Agent]
        I3[🔐 Configure Settings]
        I4[📧 Deliver to Employee]
    end
    
    subgraph System["⚙️ System"]
        S1[📡 Agent Starts]
        S2[🔐 Authenticate]
        S3[📋 Create Device Claim]
        S4[🔔 Notify Admin]
        S5[⏳ Wait for Approval]
        S6[🔗 Link Device]
        S7[📊 Set Status Online]
        S8[💓 Start Heartbeat]
        S9[📊 Begin Data Collection]
    end
    
    I1 --> I2 --> I3 --> I4
    I4 --> S1
    S1 --> S2 --> S3
    S3 --> S4
    S4 --> A1
    A1 --> A2 --> A3 --> A4
    A4 -->|Yes| A5
    A4 -->|No| A6
    A5 --> S5
    S5 --> A7
    A7 --> S6
    S6 --> S7
    S7 --> S8 --> S9
    A6 --> A8

    style Admin fill:#e3f2fd
    style IT fill:#f3e5f5
    style System fill:#fff3e0
```

### Device Lifecycle States

```
┌──────────────────────────────────────────────────────────────────────┐
│                         DEVICE LIFECYCLE                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐         │
│  │ PENDING │ ──▶│APPROVED │ ──▶│ ONLINE  │ ──▶│ACTIVE   │         │
│  │         │    │         │    │         │    │MONITORING│         │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘         │
│       │              │              │              │                 │
│       ▼              ▼              ▼              ▼                 │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐         │
│  │REJECTED │    │INACTIVE │    │OFFLINE  │    │ RETIRED │         │
│  │         │    │         │    │         │    │         │         │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Scenario 3: Device Offline Investigation — Swimlane

```mermaid
flowchart TB
    subgraph Admin["👤 Administrator"]
        A1[📊 Notice Offline Device]
        A2[🖥️ Open Device Details]
        A3[💓 Check Last Heartbeat]
        A4{Investigation Path}
        A5[📞 Contact Employee]
        A6[🔍 Check Agent Status]
        A7[🔐 Verify Device Status]
        A8[🔧 Guide Resolution]
        A9[📝 Document Issue]
        A10[✅ Verify Back Online]
    end
    
    subgraph Employee["👥 Employee"]
        E1[📞 Receive Call]
        E2[💻 Check Computer]
        E3[🔧 Fix Issue]
        E4[📧 Report Back]
    end
    
    subgraph System["⚙️ System"]
        S1[⚠️ Detect Offline]
        S2[🔔 Send Alert]
        S3[📊 Update Status]
        S4[💓 Monitor Heartbeat]
        S5[✅ Confirm Online]
    end
    
    S1 --> S2
    S2 --> A1
    A1 --> A2 --> A3 --> A4
    A4 -->|Network Issue| A5
    A4 -->|Agent Issue| A6
    A4 -->|Device Off| A7
    A5 --> E1
    E1 --> E2 --> E3 --> E4
    E4 --> A8
    A6 --> A8
    A7 --> A8
    A8 --> A9
    A9 --> A10
    A10 --> S3
    S3 --> S4
    S4 --> S5

    style Admin fill:#e3f2fd
    style Employee fill:#e8f5e9
    style System fill:#fff3e0
```

### Investigation Decision Tree

```
                    ┌─────────────────┐
                    │ Device Offline  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Check Last      │
                    │ Heartbeat       │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
    ┌───────▼───────┐ ┌─────▼─────┐ ┌───────▼───────┐
    │ Recent (<1hr) │ │ 1-24 hrs  │ │ Very Old (>24)│
    └───────┬───────┘ └─────┬─────┘ └───────┬───────┘
            │                │                │
    ┌───────▼───────┐ ┌─────▼─────┐ ┌───────▼───────┐
    │ Network Issue │ │Agent Issue│ │ Device Off    │
    └───────┬───────┘ └─────┬─────┘ └───────┬───────┘
            │                │                │
    ┌───────▼───────┐ ┌─────▼─────┐ ┌───────▼───────┐
    │ Contact       │ │ Check     │ │ Verify Status │
    │ Employee      │ │ Service   │ │               │
    └───────────────┘ └───────────┘ └───────────────┘
```

---

## Scenario 4: Employee Activity Review — Swimlane

```mermaid
flowchart TB
    subgraph Manager["👤 Manager"]
        M1[📊 Review Request]
        M2[👥 Open Employees]
        M3[🔍 Find Employee]
        M4[👤 Open Detail]
        M5[📊 Check Productivity]
        M6[📈 Review Trends]
        M7{Performance OK?}
        M8[✅ Good - Recognize]
        M9[⚠️ Needs Attention]
        M10[📋 Document Findings]
        M11[🗣️ Discuss with Employee]
        M12[📋 Set Improvement Plan]
        M13[📊 Monitor Progress]
    end
    
    subgraph HR["👥 HR Department"]
        H1[📋 Receive Report]
        H2[📝 Update Records]
        H3[🎯 Plan Training]
        H4[📊 Track Progress]
    end
    
    subgraph System["⚙️ System"]
        S1[📊 Aggregate Data]
        S2[📈 Calculate Trends]
        S3[📋 Generate Metrics]
        S4[📊 Update Dashboard]
    end
    
    S1 --> S2 --> S3
    S3 --> S4
    S4 --> M1
    M1 --> M2 --> M3 --> M4
    M4 --> M5
    M5 --> S4
    M4 --> M6
    M6 --> M7
    M7 -->|Yes| M8
    M7 -->|No| M9
    M9 --> M10 --> M11
    M11 --> M12
    M12 --> H1
    H1 --> H2 --> H3
    H3 --> M13
    M13 --> H4

    style Manager fill:#e3f2fd
    style HR fill:#f3e5f5
    style System fill:#fff3e0
```

### Activity Review Checklist

| Review Area | What to Check | Red Flags |
|-------------|---------------|-----------|
| **Productivity Score** | Overall rating (0-100) | Score < 50 consistently |
| **Work Hours** | Daily/weekly hours | Consistent overtime or underwork |
| **App Usage** | Most used applications | High unproductive time |
| **Break Patterns** | Break frequency/duration | Excessive or no breaks |
| **Activity Timeline** | Daily activity flow | Long idle periods |

---

## Scenario 5: Management Review Meeting — Swimlane

```mermaid
flowchart TB
    subgraph Admin["👤 Administrator"]
        A1[📅 Meeting Prep]
        A2[📊 Gather Dashboard Data]
        A3[📈 Analyze Analytics]
        A4[👥 Check Employee Status]
        A5[💻 Review Device Fleet]
        A6[📄 Generate Reports]
        A7[📋 Compile Summary]
        A8[🎯 Identify Action Items]
        A9[📊 Present Findings]
        A10[📝 Document Decisions]
    end
    
    subgraph Management["👔 Management"]
        M1[📅 Attend Meeting]
        M2[📊 Review Presentation]
        M3[❓ Ask Questions]
        M4[🎯 Make Decisions]
        M5[📋 Assign Actions]
        M6[✅ Approve Plan]
    end
    
    subgraph Teams["👥 Departments"]
        T1[📊 Receive Updates]
        T2[📋 Implement Changes]
        T3[📈 Track Progress]
        T4[📊 Report Back]
    end
    
    A1 --> A2 --> A3 --> A4 --> A5
    A5 --> A6 --> A7 --> A8
    A8 --> A9
    A9 --> M1
    M1 --> M2 --> M3
    M3 --> M4 --> M5
    M5 --> M6
    M6 --> A10
    A10 --> T1
    T1 --> T2 --> T3 --> T4
    T4 --> A3

    style Admin fill:#e3f2fd
    style Management fill:#e8eaf6
    style Teams fill:#e8f5e9
```

### Meeting Agenda Template

```
┌─────────────────────────────────────────────────────────────┐
│  📋 MANAGEMENT REVIEW MEETING AGENDA                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Dashboard Overview (5 min)                              │
│     • Key metrics summary                                   │
│     • Alert status                                          │
│                                                             │
│  2. Productivity Analysis (10 min)                          │
│     • Trends and patterns                                   │
│     • Department comparisons                                │
│                                                             │
│  3. Device Fleet Status (5 min)                             │
│     • Online/offline status                                 │
│     • Any issues                                            │
│                                                             │
│  4. Security & Compliance (5 min)                           │
│     • Anomalies detected                                    │
│     • Policy violations                                     │
│                                                             │
│  5. Action Items (5 min)                                    │
│     • Review previous actions                               │
│     • New assignments                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Scenario 6: Security Alert Response — Swimlane

```mermaid
flowchart TB
    subgraph Security["🔒 Security Team"]
        S1[🚨 Alert Triggered]
        S2[🔔 Acknowledge Alert]
        S3[📋 Review Details]
        S4{Severity Level}
        S5[🚨 Critical - Immediate]
        S6[⏰ High - Urgent]
        S7[📋 Medium - Review]
        S8[📝 Low - Log]
        S9[🔒 Contain if Needed]
        S10[🔍 Investigate]
        S11[📝 Document Findings]
        S12[✅ Resolve Alert]
    end
    
    subgraph Admin["👤 Administrator"]
        A1[📞 Escalation Received]
        A2[🔍 Oversee Investigation]
        A3[👤 Contact Employee]
        A4[📋 Review Policy]
        A5[🎯 Make Decision]
        A6[📊 Update Records]
    end
    
    subgraph Employee["👥 Employee"]
        E1[📞 Notified]
        E2[💻 Provide Information]
        E3[🔧 Take Corrective Action]
        E4[📧 Confirm Resolution]
    end
    
    subgraph System["⚙️ System"]
        SY1[📊 Detect Anomaly]
        SY2[🔔 Generate Alert]
        SY3[📋 Log Event]
        SY4[📊 Update Status]
        SY5[📊 Archive Alert]
    end
    
    SY1 --> SY2
    SY2 --> S1
    S1 --> S2 --> S3 --> S4
    S4 -->|Critical| S5
    S4 -->|High| S6
    S4 -->|Medium| S7
    S4 -->|Low| S8
    S5 --> S9
    S6 --> S9
    S7 --> S10
    S9 --> S10
    S10 --> A1
    A1 --> A2
    A2 --> A3
    A3 --> E1
    E1 --> E2 --> E3 --> E4
    E4 --> A4
    A4 --> A5
    A5 --> S11
    S11 --> S12
    S12 --> SY3
    SY3 --> SY4
    SY4 --> SY5

    style Security fill:#ffebee
    style Admin fill:#e3f2fd
    style Employee fill:#e8f5e9
    style System fill:#fff3e0
```

### Security Response Matrix

| Severity | Response Time | Actions | Escalation |
|----------|---------------|---------|------------|
| **Critical** | Immediate | Contain, Investigate, Resolve | Management |
| **High** | Within 1 hour | Investigate, Resolve | Admin |
| **Medium** | Within 4 hours | Review, Document | Team Lead |
| **Low** | Within 24 hours | Log, Monitor | None |

---

## Scenario 7: Consent Management — Swimlane

```mermaid
flowchart TB
    subgraph Admin["👤 Administrator"]
        A1[📋 Review Consent Status]
        A2[📝 Create Policy]
        A3[✅ Publish Policy]
        A4[📧 Request Consent]
        A5[📊 Track Responses]
        A6{Consent Status}
        A7[✅ Grant Monitoring]
        A8[🚫 No Monitoring]
        A9[🔄 Renew Expired]
        A10[📊 Update Records]
    end
    
    subgraph Employee["👥 Employee"]
        E1[📧 Receive Request]
        E2[📖 Review Policy]
        E3{Decision}
        E4[✅ Grant Consent]
        E5[❌ Deny Consent]
        E6[⏳ No Response]
    end
    
    subgraph System["⚙️ System"]
        S1[📋 Create Policy Record]
        S2[📧 Send Notification]
        S3[📊 Track Status]
        S4[🔄 Check Expiration]
        S5[📊 Update Monitoring]
        S6[🔔 Remind if Pending]
    end
    
    A1 --> A2
    A2 --> S1
    S1 --> A3
    A3 --> A4
    A4 --> S2
    S2 --> E1
    E1 --> E2 --> E3
    E3 -->|Grant| E4
    E3 -->|Deny| E5
    E3 -->|No Response| E6
    E4 --> A5
    E5 --> A5
    E6 --> S6
    S6 --> A5
    A5 --> A6
    A6 -->|Granted| A7
    A6 -->|Denied| A8
    A6 -->|Expired| A9
    A7 --> S5
    A8 --> S5
    A9 --> A4
    S5 --> A10
    A10 --> S3
    S3 --> S4
    S4 -->|Expired| A9

    style Admin fill:#e3f2fd
    style Employee fill:#e8f5e9
    style System fill:#fff3e0
```

### Consent Types Matrix

| Consent Type | What It Governs | Required | Default |
|--------------|-----------------|----------|---------|
| **Monitoring** | General monitoring | Yes | Required |
| **Screenshot** | Screen capture | Yes | Required |
| **Activity Tracking** | App/website usage | Yes | Required |
| **Keystroke** | Keyboard statistics | Optional | Disabled |
| **USB Monitoring** | USB device tracking | Optional | Disabled |
| **Location** | GPS tracking | Optional | Disabled |
| **Webcam Access** | Webcam relay | Optional | Disabled |

---

## Scenario 8: Report Generation — Swimlane

```mermaid
flowchart TB
    subgraph Admin["👤 Administrator"]
        A1[📊 Report Needed]
        A2[📋 Select Report Type]
        A3[📅 Set Date Range]
        A4[👥 Choose Scope]
        A5[📄 Select Format]
        A6[📊 Generate Report]
        A7[📥 Download Report]
        A8[📧 Distribute Report]
        A9[📁 Archive Report]
    end
    
    subgraph Management["👔 Management"]
        M1[📥 Receive Report]
        M2[📊 Review Contents]
        M3[🎯 Identify Insights]
        M4[📋 Take Action]
    end
    
    subgraph System["⚙️ System"]
        S1[📊 Query Data]
        S2[📈 Aggregate Metrics]
        S3[📄 Format Report]
        S4[💾 Store Report]
        S5[📊 Track Usage]
    end
    
    A1 --> A2
    A2 --> A3 --> A4 --> A5
    A5 --> A6
    A6 --> S1
    S1 --> S2 --> S3
    S3 --> A7
    A7 --> S4
    A7 --> A8
    A8 --> M1
    M1 --> M2 --> M3 --> M4
    M4 --> A9
    A9 --> S5

    style Admin fill:#e3f2fd
    style Management fill:#e8eaf6
    style System fill:#fff3e0
```

### Report Types & Formats

| Report Type | Best Format | Frequency | Audience |
|-------------|-------------|-----------|----------|
| **Daily Activity** | PDF | Daily | Managers |
| **Weekly Productivity** | PDF/Excel | Weekly | Management |
| **Monthly Summary** | PDF | Monthly | Executives |
| **Device Status** | Excel | Weekly | IT Admin |
| **Compliance** | PDF | Monthly | Compliance |
| **Custom** | CSV/Excel | As needed | Various |

---

## Actor Responsibility Summary

### Administrator Responsibilities

| Area | Responsibilities |
|------|------------------|
| **Employees** | Add, edit, archive, monitor |
| **Devices** | Approve, assign, troubleshoot |
| **Consent** | Create policies, grant/revoke |
| **Security** | Respond to alerts, investigate |
| **Reports** | Generate, distribute, archive |
| **Settings** | Configure system options |

### Employee Responsibilities

| Area | Responsibilities |
|------|------------------|
| **Agent** | Install, maintain, troubleshoot |
| **Consent** | Review policies, grant/deny |
| **Compliance** | Follow policies, report issues |
| **Communication** | Respond to admin inquiries |

### System Responsibilities

| Area | Responsibilities |
|------|------------------|
| **Data Collection** | Gather telemetry, screenshots |
| **Alerts** | Detect anomalies, notify |
| **Storage** | Store data per retention rules |
| **Security** | Enforce access controls |
| **Automation** | Run background jobs |

---

## RACI Matrix

| Activity | Administrator | Employee | System | Management |
|----------|---------------|----------|--------|------------|
| Add Employee | **R/A** | I | C | I |
| Install Agent | C | **R/A** | C | I |
| Approve Device | **R/A** | I | C | I |
| Grant Consent | C | **R/A** | C | I |
| Monitor Activity | **R/A** | I | **R** | I |
| Investigate Alert | **R/A** | C | C | I |
| Generate Report | **R/A** | I | **R** | I |
| Make Decisions | C | I | I | **R/A** |

**Legend:** R = Responsible, A = Accountable, C = Consulted, I = Informed

---

*Swimlane diagrams created August 2026*
*OmniSight v1.0.0*
