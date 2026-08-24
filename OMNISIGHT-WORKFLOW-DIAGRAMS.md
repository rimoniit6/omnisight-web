# OmniSight — Visual Workflow Diagrams

## Common Operational Scenarios

---

## Scenario 1: New Employee Onboarding

This workflow shows the complete process of onboarding a new employee into the OmniSight monitoring system.

```mermaid
flowchart TD
    A[👤 New Employee Joins Company] --> B[📋 Add Employee in OmniSight]
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
    P --> R[🔗 Device Assigned to Employee]
    R --> S[📊 Monitoring Begins]
    S --> T[🔒 Grant Consent]
    T --> U[✅ Onboarding Complete]
    Q --> V[📧 Notify Admin of Rejection]
    V --> W{Retry or Investigate?}
    W -->|Retry| J
    W -->|Investigate| X[🔍 Troubleshoot Issue]

    style A fill:#e1f5fe
    style U fill:#c8e6c9
    style Q fill:#ffcdd2
    style X fill:#fff3e0
```

### Steps Explained

| Step | Action | Who Does It | Result |
|------|--------|-------------|--------|
| 1 | Add Employee | Administrator | Employee record created |
| 2 | Create Agent Account | Administrator | Login credentials set |
| 3 | Install Agent | Employee | Agent software installed |
| 4 | Device Registration | System | Device appears in queue |
| 5 | Approve Device | Administrator | Device authorized |
| 6 | Grant Consent | Administrator | Monitoring permitted |
| 7 | Monitoring Begins | System | Data collection starts |

---

## Scenario 2: New Company Device Enrollment

This workflow shows how to enroll a new company-owned device.

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
    R --> S{Investigate Further?}
    S -->|Yes| T[🔍 Check Device Origin]
    S -->|No| U[❌ Device Denied]

    style A fill:#e3f2fd
    style Q fill:#c8e6c9
    style L fill:#ffcdd2
    style U fill:#ffcdd2
```

### Device States During Enrollment

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   PENDING   │ ──▶ │   APPROVED  │ ──▶ │   ONLINE    │ ──▶ │  MONITORING │
│   (New)     │     │  (Assigned) │     │  (Active)   │     │  (Collecting)│
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  REJECTED   │     │  OFFLINE    │     │  INACTIVE   │
│  (Denied)   │     │  (No Signal)│     │ (Deauth'd)  │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## Scenario 3: Device Goes Offline Investigation

This workflow shows how to investigate and resolve an offline device.

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
    V --> Y[🔍 Escalate if Needed]

    style A fill:#ffcdd2
    style W fill:#c8e6c9
    style X fill:#c8e6c9
    style Y fill:#fff3e0
```

### Investigation Checklist

- [ ] Check device status in Devices page
- [ ] Review last heartbeat timestamp
- [ ] Check if employee is on leave/break
- [ ] Verify network connectivity
- [ ] Check agent service status
- [ ] Contact employee if needed
- [ ] Document resolution

---

## Scenario 4: Employee Activity Review

This workflow shows how to review employee activity for management purposes.

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

### Activity Review Checklist

- [ ] Check productivity score trend
- [ ] Review most used applications
- [ ] Check work hours and breaks
- [ ] Verify activity categories
- [ ] Note any anomalies
- [ ] Compare with team average
- [ ] Document findings

---

## Scenario 5: Management Review Meeting

This workflow shows how to prepare for a management review meeting.

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

### Meeting Preparation Checklist

- [ ] Dashboard metrics (last 7 days)
- [ ] Productivity trends (monthly)
- [ ] Department comparisons
- [ ] Device fleet status
- [ ] Security alerts summary
- [ ] Anomaly detection results
- [ ] Action items from previous meeting

---

## Scenario 6: Security Alert Response

This workflow shows how to respond to security-related alerts.

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

### Security Response Checklist

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

## Scenario 7: Consent Management Workflow

This workflow shows how to manage employee monitoring consent.

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

### Consent Types

| Type | What It Governs | Default |
|------|-----------------|---------|
| Monitoring | General monitoring | Required |
| Screenshot | Screen capture | Required |
| Activity Tracking | App/website usage | Required |
| Keystroke | Keyboard statistics | Optional |
| USB Monitoring | USB device tracking | Optional |
| Location | GPS tracking | Optional |
| Webcam Access | Webcam relay | Optional |

---

## Scenario 8: Report Generation and Distribution

This workflow shows how to generate and distribute workforce reports.

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

### Report Types Reference

| Report | Content | Frequency | Audience |
|--------|---------|-----------|----------|
| Daily Activity | Activity summary | Daily | Managers |
| Weekly Productivity | Productivity metrics | Weekly | Management |
| Monthly Summary | Comprehensive overview | Monthly | Executives |
| Device Status | Fleet health | Weekly | IT Admin |
| Compliance | Policy adherence | Monthly | Compliance |
| Custom | User-defined | As needed | Various |

---

## Quick Reference: Common Tasks

### Daily Tasks

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

### Weekly Tasks

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

### Monthly Tasks

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

## Navigation Flow Diagram

```mermaid
flowchart LR
    subgraph Login
        A[🔐 Login Page]
    end
    
    subgraph Main Interface
        B[📊 Dashboard]
        C[👥 Employees]
        D[💻 Devices]
        E[📈 Analytics]
        F[🔒 Security]
        G[⚙️ Settings]
    end
    
    subgraph Employee Detail
        H[👤 Overview]
        I[📊 Activity]
        J[💻 Apps]
        K[📍 Location]
        L[⌨️ Keyboard]
        M[📷 Webcam]
    end
    
    subgraph Device Detail
        N[💻 Overview]
        O[📊 Activity]
        P[🔧 Health]
    end
    
    A --> B
    B --> C
    B --> D
    B --> E
    B --> F
    B --> G
    C --> H
    H --> I
    H --> J
    H --> K
    H --> L
    H --> M
    D --> N
    N --> O
    N --> P
```

---

*Workflow diagrams created August 2026*
*OmniSight v1.0.0*
