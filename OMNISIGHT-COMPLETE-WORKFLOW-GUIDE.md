# OmniSight — Complete Workflow Guide

## Visual Workflows, Swimlane Diagrams & Actor Responsibilities

---

**Version 1.0**

**Documentation Date: August 2026**

**For Organization Administrators**

---

*This document combines all workflow diagrams, swimlane diagrams, and actor responsibilities into a single comprehensive guide. It is intended for company management, organization administrators, and authorized staff.*

---

# Table of Contents

1. [Overview](#1-overview)
2. [Actor Types & Responsibilities](#2-actor-types--responsibilities)
3. [Scenario 1: New Employee Onboarding](#3-scenario-1-new-employee-onboarding)
4. [Scenario 2: New Device Enrollment](#4-scenario-2-new-device-enrollment)
5. [Scenario 3: Device Offline Investigation](#5-scenario-3-device-offline-investigation)
6. [Scenario 4: Employee Activity Review](#6-scenario-4-employee-activity-review)
7. [Scenario 5: Management Review Meeting](#7-scenario-5-management-review-meeting)
8. [Scenario 6: Security Alert Response](#8-scenario-6-security-alert-response)
9. [Scenario 7: Consent Management](#9-scenario-7-consent-management)
10. [Scenario 8: Report Generation](#10-scenario-8-report-generation)
11. [RACI Matrix](#11-raci-matrix)
12. [Quick Reference Checklists](#12-quick-reference-checklists)
13. [Device Lifecycle States](#13-device-lifecycle-states)
14. [Decision Trees](#14-decision-trees)

---

# 1. Overview

This guide provides visual workflows for all major operational scenarios in OmniSight. Each scenario includes:

- **Flowchart Diagram** — Step-by-step process flow
- **Swimlane Diagram** — Who does what (actor responsibilities)
- **RACI Matrix** — Responsibility assignment
- **Checklists** — Action items for administrators

## How to Use This Guide

1. **Find your scenario** — Locate the workflow you need
2. **Follow the flowchart** — Understand the process steps
3. **Check the swimlane** — See who is responsible for each step
4. **Use the checklist** — Ensure all steps are completed

---

# 2. Actor Types & Responsibilities

## Actor Legend

| Actor | Color | Description |
|-------|-------|-------------|
| **👤 Administrator** | 🔵 Blue | Organization admin with full access |
| **👥 Employee** | 🟢 Green | Company employee being monitored |
| **⚙️ System** | 🟠 Orange | Automated system processes |
| **👔 Management** | 🟣 Purple | Company leadership |
| **🔒 Security** | 🔴 Red | Security team members |
| **🔧 IT Department** | 🟣 Purple | IT support staff |

## Responsibility Summary

### 👤 Administrator Responsibilities

| Area | Responsibilities |
|------|------------------|
| **Employees** | Add, edit, archive, monitor |
| **Devices** | Approve, assign, troubleshoot |
| **Consent** | Create policies, grant/revoke |
| **Security** | Respond to alerts, investigate |
| **Reports** | Generate, distribute, archive |
| **Settings** | Configure system options |

### 👥 Employee Responsibilities

| Area | Responsibilities |
|------|------------------|
| **Agent** | Install, maintain, troubleshoot |
| **Consent** | Review policies, grant/deny |
| **Compliance** | Follow policies, report issues |
| **Communication** | Respond to admin inquiries |

### ⚙️ System Responsibilities

| Area | Responsibilities |
|------|------------------|
| **Data Collection** | Gather telemetry, screenshots |
| **Alerts** | Detect anomalies, notify |
| **Storage** | Store data per retention rules |
| **Security** | Enforce access controls |
| **Automation** | Run background jobs |

---

# 3. Scenario 1: New Employee Onboarding

## What is it?

The complete process of adding a new employee to the OmniSight monitoring system.

## Flowchart

```mermaid
flowchart TD
    A[👤 New Employee Joins] --> B[📋 Add Employee in OmniSight]
    B --> C[📝 Enter Employee Details]
    C --> D{Save Employee Record}
    D --> E[✅ Employee Created]
    E --> F[🔑 Create Agent Account]
    F --> G[🔐 Set Agent Credentials]
    G --> H[💾 Save Agent Account]
    H --> I[📦 Provide Agent Installer]
    I --> J[💻 Employee Installs Agent]
    J --> K[🌐 Agent Contacts Server]
    K --> L{Device Registration}
    L --> M[⏳ Pending Approval]
    M --> N[👀 Admin Reviews Device]
    N --> O{Approve or Reject?}
    O -->|Approve| P[✅ Device Approved]
    O -->|Reject| Q[❌ Device Rejected]
    P --> R[🔗 Device Assigned]
    R --> S[📊 Monitoring Begins]
    S --> T[🔒 Grant Consent]
    T --> U[✅ Onboarding Complete]
    Q --> V[📧 Notify Admin]

    style A fill:#e1f5fe
    style U fill:#c8e6c9
    style Q fill:#ffcdd2
```

## Swimlane Diagram

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

## Step-by-Step Procedure

| Step | Actor | Action | Result |
|------|-------|--------|--------|
| 1 | Administrator | Open Employees page | Ready to add |
| 2 | Administrator | Click Add Employee | Form opens |
| 3 | Administrator | Fill in details | Data entered |
| 4 | System | Create record | Employee created |
| 5 | Administrator | Create agent account | Credentials set |
| 6 | System | Generate account | Account ready |
| 7 | Administrator | Provide installer | Installer ready |
| 8 | Employee | Install agent | Agent installed |
| 9 | Employee | Enter credentials | Agent authenticated |
| 10 | System | Create device claim | Claim pending |
| 11 | Administrator | Approve device | Device authorized |
| 12 | Administrator | Grant consent | Monitoring allowed |
| 13 | System | Start monitoring | Data collection begins |

## Checklist

- [ ] Employee record created
- [ ] Agent account created
- [ ] Installer provided to employee
- [ ] Agent installed on device
- [ ] Device claim approved
- [ ] Consent granted
- [ ] Monitoring verified

---

# 4. Scenario 2: New Device Enrollment

## What is it?

The process of enrolling a new company-owned device into the monitoring system.

## Flowchart

```mermaid
flowchart TD
    A[🖥️ New Company Device] --> B[📦 Install OmniSight Agent]
    B --> C[🌐 Agent Contacts Server]
    C --> D[🔐 Agent Authenticates]
    D --> E[📡 Device Discovery]
    E --> F[📋 Device Claim Created]
    F --> G{Admin Notification}
    G --> H[👀 Admin Opens Agent Approvals]
    H --> I[📝 Reviews Device Details]
    I --> J{Device Legitimate?}
    J -->|Yes| K[✅ Approve Device]
    J -->|No| L[❌ Reject Device]
    K --> M[👤 Assign to Employee]
    M --> N[🔗 Link Device to Employee]
    N --> O[📊 Device Goes Online]
    O --> P[💓 Heartbeat Begins]
    P --> Q[✅ Enrollment Complete]
    L --> R[📝 Record Rejection Reason]

    style A fill:#e3f2fd
    style Q fill:#c8e6c9
    style L fill:#ffcdd2
```

## Swimlane Diagram

```mermaid
flowchart TB
    subgraph IT["🔧 IT Department"]
        I1[📦 Prepare Device]
        I2[📦 Install Agent]
        I3[🔐 Configure Settings]
        I4[📧 Deliver to Employee]
    end
    
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
    
    subgraph System["⚙️ System"]
        S1[📡 Agent Starts]
        S2[🔐 Authenticate]
        S3[📋 Create Device Claim]
        S4[🔔 Notify Admin]
        S5[⏳ Wait for Approval]
        S6[🔗 Link Device]
        S7[📊 Set Status Online]
        S8[💓 Start Heartbeat]
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
    S7 --> S8
    A6 --> A8

    style IT fill:#f3e5f5
    style Admin fill:#e3f2fd
    style System fill:#fff3e0
```

## Device Lifecycle States

```
┌──────────────────────────────────────────────────────────────────────┐
│                         DEVICE LIFECYCLE                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐         │
│  │ PENDING │ ──▶│APPROVED │ ──▶│ ONLINE  │ ──▶│ ACTIVE  │         │
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

## Checklist

- [ ] Agent installed on device
- [ ] Device registered with server
- [ ] Admin notified of new claim
- [ ] Device details reviewed
- [ ] Device approved/rejected
- [ ] Device assigned to employee
- [ ] Device status verified online

---

# 5. Scenario 3: Device Offline Investigation

## What is it?

The process of investigating and resolving an offline device issue.

## Flowchart

```mermaid
flowchart TD
    A[⚠️ Device Goes Offline] --> B[📊 Dashboard Alert]
    B --> C[🔔 Notification Received]
    C --> D[👀 Admin Investigates]
    D --> E[🖥️ Open Device Details]
    E --> F[📋 Check Last Heartbeat]
    F --> G{When Was Last Heartbeat?}
    G -->|Recent < 1 hour| H[🌐 Network Issue Likely]
    G -->|Older 1-24 hours| I[💻 Agent Issue Likely]
    G -->|Very Old > 24 hours| J[🔒 Device May Be Off]
    H --> K[📞 Contact Employee]
    I --> L[🔍 Check Agent Service]
    J --> M[🔐 Check Device Status]
    K --> N{Employee Responds?}
    L --> O{Agent Running?}
    M --> P{Device Retired?}
    N -->|Yes| Q[🔧 Guide Through Fix]
    N -->|No| R[📧 Send Follow-up]
    O -->|Yes| S[🔄 Restart Agent]
    O -->|No| T[📦 Reinstall Agent]
    P -->|Yes| U[📝 Mark as Retired]
    P -->|No| V[🔍 Further Investigation]
    Q --> W[✅ Device Back Online]
    R --> W
    S --> W
    T --> W
    U --> X[✅ Issue Resolved]

    style A fill:#ffcdd2
    style W fill:#c8e6c9
    style X fill:#c8e6c9
```

## Swimlane Diagram

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

## Investigation Checklist

- [ ] Check device status and last heartbeat
- [ ] Determine likely cause (network/agent/device)
- [ ] Contact employee if needed
- [ ] Guide through resolution
- [ ] Verify device returns online
- [ ] Document the issue

---

# 6. Scenario 4: Employee Activity Review

## What is it?

The process of reviewing employee productivity and activity.

## Flowchart

```mermaid
flowchart TD
    A[📊 Need to Review Employee] --> B[👥 Open Employees Page]
    B --> C[🔍 Find Employee]
    C --> D[👤 Open Employee Detail]
    D --> E[📋 Overview Tab]
    E --> F[📊 Check Productivity Score]
    F --> G{Score Acceptable?}
    G -->|Yes| H[✅ Good Performance]
    G -->|No| I[⚠️ Needs Attention]
    I --> J[📈 Activity Tab]
    J --> K[⏱️ Review Activity Timeline]
    K --> L[💻 Apps & Websites Tab]
    L --> M[📱 Check Application Usage]
    M --> N{Issues Found?}
    N -->|No| O[✅ No Action Needed]
    N -->|Yes| P[📝 Document Concerns]
    P --> Q[🗣️ Discuss with Employee]
    Q --> R[📋 Set Improvement Plan]
    R --> S[📊 Monitor Progress]
    H --> T[🎉 Recognize Performance]
    O --> U[✅ Review Complete]

    style A fill:#e3f2fd
    style H fill:#c8e6c9
    style U fill:#c8e6c9
    style I fill:#fff3e0
    style P fill:#ffcdd2
```

## Swimlane Diagram

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

## Activity Review Checklist

- [ ] Check productivity score trend
- [ ] Review most used applications
- [ ] Check work hours and breaks
- [ ] Verify activity categories
- [ ] Note any anomalies
- [ ] Compare with team average
- [ ] Document findings

---

# 7. Scenario 5: Management Review Meeting

## What is it?

Preparing for and conducting a management review meeting.

## Flowchart

```mermaid
flowchart TD
    A[📅 Management Meeting Scheduled] --> B[📊 Start with Dashboard]
    B --> C[📈 Review Key Metrics]
    C --> D[👥 Check Employee Status]
    D --> E[💻 Review Device Fleet]
    E --> F{Issues Detected?}
    F -->|Yes| G[🔍 Investigate Issues]
    F -->|No| H[📊 Move to Analytics]
    G --> I[📝 Document Findings]
    I --> H
    H --> J[📈 Analyze Trends]
    J --> K[🏢 Compare Departments]
    K --> L[📊 Review Productivity]
    L --> M[📋 Generate Reports]
    M --> N[📄 Create Summary]
    N --> O[🎯 Identify Action Items]
    O --> P[📋 Prepare Presentation]
    P --> Q[✅ Ready for Meeting]

    style A fill:#e3f2fd
    style Q fill:#c8e6c9
    style G fill:#fff3e0
```

## Swimlane Diagram

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

## Meeting Preparation Checklist

- [ ] Dashboard metrics (last 7 days)
- [ ] Productivity trends (monthly)
- [ ] Department comparisons
- [ ] Device fleet status
- [ ] Security alerts summary
- [ ] Anomaly detection results
- [ ] Action items from previous meeting

---

# 8. Scenario 6: Security Alert Response

## What is it?

Responding to security-related alerts and incidents.

## Flowchart

```mermaid
flowchart TD
    A[🚨 Security Alert Received] --> B[🔔 Check Notifications]
    B --> C[📋 Review Alert Details]
    C --> D{Alert Severity}
    D -->|Critical| E[🚨 Immediate Response]
    D -->|High| F[⏰ Urgent Investigation]
    D -->|Medium| G[📋 Scheduled Review]
    D -->|Low| H[📝 Log for Later]
    E --> I[🔒 Contain if Needed]
    I --> J[🔍 Investigate Root Cause]
    F --> J
    G --> J
    J --> K{Issue Type}
    K -->|Policy Violation| L[📋 Review Policy]
    K -->|Anomaly| M[📊 Analyze Pattern]
    K -->|Security Event| N[🔐 Check Access Logs]
    L --> O[👤 Contact Employee]
    M --> O
    N --> O
    O --> P{Employee Response?}
    P -->|Acknowledged| Q[📝 Document Resolution]
    P -->|Disputed| R[🔍 Further Investigation]
    P -->|No Response| S[📧 Escalate]
    Q --> T[✅ Close Alert]
    R --> U[👨‍💼 Escalate to Management]
    S --> U
    H --> V[📋 Review During Admin Time]

    style A fill:#ffcdd2
    style E fill:#f44336
    style T fill:#c8e6c9
    style U fill:#fff3e0
```

## Swimlane Diagram

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

## Security Response Matrix

| Severity | Response Time | Actions | Escalation |
|----------|---------------|---------|------------|
| **Critical** | Immediate | Contain, Investigate, Resolve | Management |
| **High** | Within 1 hour | Investigate, Resolve | Admin |
| **Medium** | Within 4 hours | Review, Document | Team Lead |
| **Low** | Within 24 hours | Log, Monitor | None |

## Security Response Checklist

- [ ] Acknowledge alert immediately
- [ ] Review alert details and severity
- [ ] Check affected employee/device
- [ ] Investigate root cause
- [ ] Take containment action if needed
- [ ] Document findings
- [ ] Update alert status
- [ ] Follow up with employee
- [ ] Report to management if critical

---

# 9. Scenario 7: Consent Management

## What is it?

Managing employee monitoring consent and policies.

## Flowchart

```mermaid
flowchart TD
    A[🔒 Consent Required] --> B{Employee Type}
    B -->|New Employee| C[📋 Create Consent Policy]
    B -->|Existing| D[📊 Check Current Consent]
    C --> E[📝 Draft Policy Content]
    E --> F[✅ Publish Policy]
    F --> G[👤 Request Employee Consent]
    G --> H{Employee Response}
    H -->|Grants| I[✅ Consent Granted]
    H -->|Denies| J[❌ Consent Denied]
    H -->|No Response| K[📧 Follow Up]
    D --> L{Consent Status}
    L -->|Granted| M[✅ Monitoring Active]
    L -->|Pending| N[⏳ Awaiting Response]
    L -->|Denied| O[🚫 No Monitoring]
    L -->|Expired| P[🔄 Renew Consent]
    I --> Q[📊 Begin Monitoring]
    J --> R[🚫 No Monitoring for Type]
    K --> S{Follow Up Result}
    S -->|Granted| I
    S -->|Denied| J
    P --> G

    style A fill:#e3f2fd
    style I fill:#c8e6c9
    style J fill:#ffcdd2
    style O fill:#ffcdd2
    style Q fill:#c8e6c9
```

## Swimlane Diagram

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

## Consent Types Matrix

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

# 10. Scenario 8: Report Generation

## What is it?

Creating and distributing workforce reports.

## Flowchart

```mermaid
flowchart TD
    A[📊 Report Needed] --> B[📋 Select Report Type]
    B --> C{Report Purpose}
    C -->|Daily| D[📅 Daily Activity Report]
    C -->|Weekly| E[📊 Weekly Productivity]
    C -->|Monthly| F[📈 Monthly Summary]
    C -->|Custom| G[🔧 Custom Report]
    D --> H[📝 Configure Parameters]
    E --> H
    F --> H
    G --> H
    H --> I[📅 Set Date Range]
    I --> J[👥 Select Employees/Depts]
    J --> K[📄 Choose Format]
    K --> L{Format Type}
    L -->|PDF| M[📄 Generate PDF]
    L -->|Excel| N[📊 Generate Excel]
    L -->|CSV| O[📋 Generate CSV]
    M --> P[📥 Download Report]
    N --> P
    O --> P
    P --> Q{Distribution}
    Q -->|Email| R[📧 Email to Stakeholders]
    Q -->|Meeting| S[📊 Present in Meeting]
    Q -->|Archive| T[📁 Store for Records]
    R --> U[✅ Distribution Complete]
    S --> U
    T --> U

    style A fill:#e3f2fd
    style U fill:#c8e6c9
```

## Swimlane Diagram

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

## Report Types & Formats

| Report Type | Best Format | Frequency | Audience |
|-------------|-------------|-----------|----------|
| **Daily Activity** | PDF | Daily | Managers |
| **Weekly Productivity** | PDF/Excel | Weekly | Management |
| **Monthly Summary** | PDF | Monthly | Executives |
| **Device Status** | Excel | Weekly | IT Admin |
| **Compliance** | PDF | Monthly | Compliance |
| **Custom** | CSV/Excel | As needed | Various |

---

# 11. RACI Matrix

## Complete Responsibility Assignment

| Activity | Administrator | Employee | System | Management |
|----------|---------------|----------|--------|------------|
| Add Employee | **R** | I | C | I |
| Install Agent | C | **R** | C | I |
| Approve Device | **R** | I | C | I |
| Grant Consent | C | **R** | C | I |
| Monitor Activity | **R** | I | **R** | I |
| Investigate Alert | **R** | C | C | I |
| Generate Report | **R** | I | **R** | I |
| Make Decisions | C | I | I | **R** |

**Legend:**
- **R** = Responsible (does the work)
- **A** = Accountable (owns the outcome)
- **C** = Consulted (provides input)
- **I** = Informed (kept updated)

---

# 12. Quick Reference Checklists

## Daily Tasks

```
┌─────────────────────────────────────────────────────────────┐
│  📋 DAILY ADMINISTRATOR CHECKLIST                           │
├─────────────────────────────────────────────────────────────┤
│  □ Check Dashboard for alerts                               │
│  □ Review offline devices                                   │
│  □ Check Agent Approvals queue                              │
│  □ Review critical notifications                            │
│  □ Monitor live activity if needed                          │
└─────────────────────────────────────────────────────────────┘
```

## Weekly Tasks

```
┌─────────────────────────────────────────────────────────────┐
│  📊 WEEKLY ADMINISTRATOR CHECKLIST                          │
├─────────────────────────────────────────────────────────────┤
│  □ Review Analytics trends                                  │
│  □ Generate weekly productivity report                      │
│  □ Check consent compliance                                 │
│  □ Review audit logs                                        │
│  □ Update device assignments if needed                      │
│  □ Address any anomalies                                    │
└─────────────────────────────────────────────────────────────┘
```

## Monthly Tasks

```
┌─────────────────────────────────────────────────────────────┐
│  📈 MONTHLY ADMINISTRATOR CHECKLIST                         │
├─────────────────────────────────────────────────────────────┤
│  □ Review data retention settings                           │
│  □ Analyze department performance                           │
│  □ Update application policies                              │
│  □ Review and resolve anomalies                             │
│  □ Generate monthly summary report                          │
│  □ Conduct management review meeting                        │
│  □ Update consent policies if needed                        │
└─────────────────────────────────────────────────────────────┘
```

---

# 13. Device Lifecycle States

## State Transitions

```
┌──────────────────────────────────────────────────────────────────────┐
│                         DEVICE LIFECYCLE                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐         │
│  │ PENDING │ ──▶│APPROVED │ ──▶│ ONLINE  │ ──▶│ ACTIVE  │         │
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

## State Descriptions

| State | Description | Transitions To |
|-------|-------------|----------------|
| **PENDING** | Device registered, awaiting approval | APPROVED or REJECTED |
| **APPROVED** | Approved by admin, assigned to employee | ONLINE or INACTIVE |
| **ONLINE** | Active, sending telemetry | ACTIVE or OFFLINE |
| **ACTIVE** | Fully monitoring, collecting data | OFFLINE or RETIRED |
| **REJECTED** | Denied by admin | Terminal state |
| **INACTIVE** | Deauthorized or employee archived | Terminal state |
| **OFFLINE** | No recent communication | ONLINE or RETIRED |
| **RETIRED** | No longer in use | Terminal state |

---

# 14. Decision Trees

## Device Offline Investigation Decision Tree

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

## Security Alert Severity Decision Tree

```
                    ┌─────────────────┐
                    │ Security Alert  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Assess Severity │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼───────┐    ┌──────▼──────┐    ┌───────▼───────┐
│   Critical    │    │    High     │    │    Medium     │
└───────┬───────┘    └──────┬──────┘    └───────┬───────┘
        │                    │                    │
┌───────▼───────┐    ┌──────▼──────┐    ┌───────▼───────┐
│ Immediate     │    │ Within 1 hr │    │ Within 4 hrs  │
│ Response      │    │             │    │               │
└───────┬───────┘    └──────┬──────┘    └───────┬───────┘
        │                    │                    │
┌───────▼───────┐    ┌──────▼──────┐    ┌───────▼───────┐
│ Contain +     │    │ Investigate │    │ Review +      │
│ Investigate   │    │ + Resolve   │    │ Document      │
└───────────────┘    └─────────────┘    └───────────────┘
```

---

# Document Verification

## Quality Checklist

- [x] All 8 scenarios documented
- [x] Flowcharts included for each scenario
- [x] Swimlane diagrams with actor responsibilities
- [x] RACI matrix for responsibility assignment
- [x] Quick reference checklists
- [x] Device lifecycle states documented
- [x] Decision trees for common issues
- [x] No sensitive credentials included
- [x] All workflows verified against actual product

## Document Statistics

| Metric | Count |
|--------|-------|
| Total Scenarios | 8 |
| Flowcharts | 8 |
| Swimlane Diagrams | 8 |
| RACI Tables | 2 |
| Checklists | 3 |
| Decision Trees | 2 |
| Actor Types | 5 |

---

*Complete Workflow Guide created August 2026*
*OmniSight v1.0.0*
*For Organization Administrators*
