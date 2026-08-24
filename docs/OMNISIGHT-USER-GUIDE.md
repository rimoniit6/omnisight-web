# OmniSight — Organization Administrator User Guide

**Version:** 2.1.4
**Date:** August 25, 2026
**Audience:** Organization Administrators, Managers, IT Staff

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Getting Started](#2-getting-started)
3. [Login & Authentication](#3-login--authentication)
4. [Dashboard](#4-dashboard)
5. [Employee Management](#5-employee-management)
6. [Device Management](#6-device-management)
7. [Activity Monitoring](#7-activity-monitoring)
8. [Screenshots](#8-screenshots)
9. [Projects & Time Tracking](#9-projects--time-tracking)
10. [Reports & Exports](#10-reports--exports)
11. [Live Monitor](#11-live-monitor)
12. [Notifications](#12-notifications)
13. [Agent Approvals & Device Claims](#13-agent-approvals--device-claims)
14. [Departments](#14-departments)
15. [Analytics](#15-analytics)
16. [Organization Management](#16-organization-management)
17. [Policies](#17-policies)
18. [Guests](#18-guests)
19. [Consent Management](#19-consent-management)
20. [Settings](#20-settings)
21. [Security & RBAC](#21-security--rbac)
22. [Common Administrative Workflows](#22-common-administrative-workflows)
23. [Troubleshooting](#23-troubleshooting)
24. [Feature Summary](#24-feature-summary)

---

## 1. Product Overview

OmniSight is an AI-powered workforce intelligence platform that helps organizations monitor employee productivity, manage devices, track project time, and ensure compliance — all from a single dashboard.

### What OmniSight Does

- **Employee Monitoring:** Track application usage, website visits, and productive time
- **Device Management:** Monitor device health, status, and agent installations
- **Project Time Tracking:** Automatically track time spent on projects from activity data
- **AI-Powered Insights:** Get intelligent recommendations on productivity, burnout risk, and workload balance
- **Compliance & Consent:** Manage employee consent and data retention policies
- **Real-Time Monitoring:** Live view of employee and device activity
- **Security:** Detect policy violations, unusual logins, and USB events

### Key Terminology

| Term | Definition |
|------|-----------|
| **Employee** | A tracked person in the organization (has an agent installed on their device) |
| **Device** | A computer running the OmniSight agent software |
| **Activity** | An application or website usage record captured by the agent |
| **Agent** | The desktop software installed on employee computers |
| **Consent** | Employee permission for specific types of monitoring |
| **Policy** | Organization rules for application whitelisting/blacklisting |
| **Guest** | A temporarily monitored person (no employee account) |

---

## 2. Getting Started

### First-Time Setup

1. **Log in** with your administrator credentials
2. **Create your organization** (name, timezone, address)
3. **Set up departments** that match your company structure
4. **Add employees** manually or invite them to install the agent
5. **Configure policies** for application monitoring
6. **Review consent** requirements for your jurisdiction

### System Requirements

- **Web Browser:** Chrome, Firefox, Safari, or Edge (latest versions)
- **Agent Software:** Windows 10/11, macOS 12+, or Ubuntu 20.04+
- **Network:** Agents must be able to reach your OmniSight server

---

## 3. Login & Authentication

![Login Page](/docs/screenshots/01-login.png)

### How to Log In

1. Navigate to your OmniSight URL (e.g., `https://your-domain.com`)
2. Enter your **email address** in the "Email Address" field
3. Enter your **password** in the "Password" field
4. Click **"Sign In"**

### Login Credentials

| Role | Email | Password |
|------|-------|----------|
| Organization Admin | `org.admin@acmetech.com` | `demo1234` |
| Manager | `manager@acmetech.com` | `demo1234` |
| Viewer | `viewer@acmetech.com` | `demo1234` |

### Session Management

- Sessions are maintained via secure HTTP-only cookies
- Sessions expire after 7 days of inactivity
- Logging out invalidates the session server-side
- Multiple concurrent sessions are supported

### Password Requirements

- Minimum 8 characters
- Must include uppercase, lowercase, and digit
- Passwords are hashed with bcrypt (never stored in plaintext)

---

## 4. Dashboard

![Dashboard](/docs/screenshots/02-dashboard.png)

### Purpose

The Dashboard is your command center — a single-page overview of your organization's workforce activity, productivity metrics, and key alerts.

### What You See

| Section | Description |
|---------|-------------|
| **KPI Cards** | Total Employees, Online Devices, Active Alerts, Productivity Score |
| **Department Breakdown** | Employee count and productivity by department |
| **Device Status** | Online vs. offline device distribution |
| **Daily Productivity** | 7-day productivity trend chart |
| **Recent Activities** | Latest employee activity feed |
| **Top Performers** | Employees with highest productive time |

### What You Can Do

- **Quick Actions:** Add Employee, Generate Report, View Alerts, Export PDF
- **Customize:** Click "Customize" to rearrange dashboard cards
- **Live Mode:** Click "Live" to enable real-time dashboard updates
- **Date Range:** Select different time periods for productivity metrics

### Dashboard Data Updates

- KPI cards update every 30 seconds
- Activity feed updates in real-time via WebSocket
- Productivity scores recalculate hourly

### Understanding the Productivity Score

The productivity score is calculated as:
```
(Productive Time ÷ Total Categorized Time) × 100
```

- **Green (70%+):** High productivity
- **Yellow (40-69%):** Moderate productivity
- **Red (<40%):** Low productivity — investigate

---

## 5. Employee Management

![Employees Page](/docs/screenshots/03-employees.png)

### Purpose

Manage your workforce — view all employees, their status, departments, and device assignments.

### Employee List Overview

The employee list shows:
- **Name** and **Employee ID**
- **Email** and **Department**
- **Designation** (job title)
- **Status** (Active, Inactive, Archived)
- **Device** assignment
- **Created** date

### Creating an Employee

**Step 1:** Click **"Add Employee"** button (top-right of the page)

**Step 2:** Fill in the required fields:

| Field | Required | Description |
|-------|----------|-------------|
| First Name | ✅ | Employee's first name |
| Last Name | ✅ | Employee's last name |
| Email | ✅ | Work email address (must be unique) |
| Phone | Optional | Contact number |
| Employee ID | ✅ | Unique identifier (auto-generated or custom) |
| Department | Optional | Assign to a department |
| Designation | Optional | Job title |
| Join Date | Optional | Employment start date |

**Step 3:** Click **"Create"**

**What Happens:**
- Employee record is created in the database
- Employee appears in the employee list immediately
- Employee can be assigned a device later
- Agent installation instructions are available in Employee Details

### Editing an Employee

1. Click on the employee's name in the list
2. Click **"Edit"** in the employee detail view
3. Modify the desired fields
4. Click **"Save"**

### Deactivating an Employee

1. Open the employee detail view
2. Change status from "Active" to "Inactive"
3. The employee's agent will stop reporting data
4. Historical data is preserved

### Searching & Filtering

- **Search:** Type in the search box to filter by name, email, or employee ID
- **Status Filter:** Filter by Active, Inactive, or Archived
- **Department Filter:** Filter by specific department
- **Role Filter:** Filter by employee role
- **Device Filter:** Filter by device assignment status

### Bulk Actions

- **Export:** Download employee list as CSV or XLSX
- **Import:** Upload employees from a CSV file
- **Bulk Edit:** Select multiple employees and change status or department

### Employee Detail View

![Employee Detail](/docs/screenshots/04-employee-detail.png)

The employee detail page shows:
- **Profile Information:** Name, email, phone, designation
- **Department & Status:** Current assignment and employment status
- **Device Assignment:** Which device is assigned to this employee
- **Activity Summary:** Recent application and website usage
- **Time Entries:** Project time logged
- **Consent Status:** Which monitoring consents have been granted

---

## 6. Device Management

![Devices Page](/docs/screenshots/05-devices.png)

### Purpose

Monitor all devices running the OmniSight agent — their status, health, and employee assignments.

### Device List Overview

Each device shows:
- **Name** and **Hostname**
- **Operating System** (Windows, macOS, Ubuntu)
- **Status** (Online, Offline, Inactive)
- **Assigned Employee**
- **Last Heartbeat** (when the agent last checked in)
- **Agent Version**

### Device Status Explained

| Status | Meaning |
|--------|---------|
| **Online** | Agent is running and heartbeat is fresh (<5 minutes) |
| **Offline** | Agent hasn't sent a heartbeat in >5 minutes |
| **Inactive** | Device has been manually deactivated |
| **Maintenance** | Device is under IT maintenance |

### Device Approval Workflow

When a new device connects:

1. **Device Discovery:** Agent sends device info to the server
2. **Claim Created:** A "Device Claim" appears in Agent Approvals
3. **Admin Review:** Admin reviews device details and employee assignment
4. **Approval:** Admin approves the claim → device becomes active
5. **Rejection:** Admin rejects the claim → device is blocked

### Device Details

Clicking a device shows:
- **Hardware Info:** OS, processor, memory, IP address
- **Agent Version:** Current installed version
- **Employee Assignment:** Who uses this device
- **Activity History:** Recent application usage
- **Heartbeat Log:** Connection history

### Remote Actions

| Action | Description |
|--------|-------------|
| **View Details** | See full device information |
| **Reassign** | Change the assigned employee |
| **Deactivate** | Stop monitoring this device |
| **View Activity** | See what apps/websites were used |

---

## 7. Activity Monitoring

![Activities Page](/docs/screenshots/06-activities.png)

### Purpose

Track what applications and websites employees use throughout the day.

### Activity Types

| Type | Description |
|------|-------------|
| **Application** | Desktop application usage (e.g., VS Code, Chrome, Slack) |
| **Website** | Browser website visits (e.g., GitHub, Stack Overflow) |

### Activity Categories

| Category | Color | Meaning |
|----------|-------|---------|
| **Productive** | Green | Work-related tools (IDE, documentation, project management) |
| **Neutral** | Yellow | Communication tools (email, calendar) |
| **Unproductive** | Red | Non-work sites (social media, entertainment) |

### Activity List Features

- **Timeline View:** See activities in chronological order
- **Duration:** How long each application/website was used
- **Employee Filter:** Filter by specific employee
- **Device Filter:** Filter by specific device
- **Category Filter:** Show only productive, neutral, or unproductive
- **Date Range:** Filter by time period

### Understanding Activity Data

Each activity record contains:
- **Application Name:** e.g., "Visual Studio Code"
- **Executable:** e.g., "code.exe"
- **Duration:** Time spent (in seconds)
- **Category:** Productive/Neutral/Unproductive
- **Timestamp:** When the activity was recorded

### Exporting Activities

1. Click **"Export"** button
2. Choose format: **CSV** or **XLSX**
3. Apply filters if needed (employee, date range, category)
4. Download the file

---

## 8. Screenshots

![Screenshots Page](/docs/screenshots/07-screenshots.png)

### Purpose

View and manage screenshots captured by the agent for monitoring and compliance purposes.

### Screenshot List Overview

Each screenshot shows:
- **Employee** who was captured
- **Application** in focus when captured
- **Capture Time**
- **File Size**
- **Flag Status** (if sensitive content detected)

### Screenshot Details

Clicking a screenshot shows:
- **Preview:** The actual screenshot image
- **Metadata:** Resolution, file size, capture time
- **OCR Text:** Text detected in the screenshot (if available)
- **AI Analysis:** Automated content analysis
- **Flag Reason:** Why it was flagged (if applicable)

### Screenshot Retention

- Screenshots are retained based on your organization's data retention policy
- Default retention: 90 days
- Flagged screenshots may be retained longer for compliance
- Screenshots can be manually deleted by admins

### Privacy Considerations

- Screenshots are captured at configurable intervals (default: 5 minutes)
- Employees must consent to screenshot monitoring
- Sensitive content is automatically flagged
- Screenshots are stored securely with access controls

---

## 9. Projects & Time Tracking

![Projects Page](/docs/screenshots/08-projects.png)

### Purpose

Manage projects, assign team members, and track time spent on each project.

### Project List Overview

Each project shows:
- **Name** and **Description**
- **Status** (Active, On Hold, Completed, Cancelled)
- **Priority** (Low, Medium, High, Critical)
- **Team Members** count
- **Deadline**
- **Budget Type** (Fixed, Hourly)

### Creating a Project

**Step 1:** Click **"Create Project"** button

**Step 2:** Fill in project details:

| Field | Required | Description |
|-------|----------|-------------|
| Name | ✅ | Project name |
| Description | Optional | Project overview |
| Status | ✅ | Current status |
| Priority | ✅ | Importance level |
| Start Date | Optional | Project start |
| Deadline | Optional | Due date |
| Estimated Hours | Optional | Budget in hours |
| Budget Type | Optional | Fixed or Hourly |
| Hourly Rate | Optional | For hourly billing |
| Color | Optional | Visual identifier |

**Step 3:** Click **"Create"**

**Step 4:** Add team members via the project detail page

### Time Entries

Time entries are automatically generated from employee activity data:
- **Source:** `ACTIVITY_AUTO` (system-generated) or `MANUAL` (admin-entered)
- **Hours:** Calculated from activity duration
- **Category:** development, design, meeting, research, testing, review, admin
- **Billable:** Whether the time is billable to a client

### Viewing Time Entries

1. Open a project
2. Click **"Time Entries"** tab
3. Filter by employee, date range, or category
4. Export as CSV or XLSX

### Project Reports

- **Project Summary:** Total hours, member contributions, budget status
- **Member Breakdown:** Hours per team member
- **Category Breakdown:** Time by activity type
- **Date Trend:** Time logged over days/weeks

---

## 10. Reports & Exports

![Reports Page](/docs/screenshots/09-reports.png)

### Purpose

Generate and download reports on workforce activity, productivity, and compliance.

### Available Report Types

| Report | Description | Format |
|--------|-------------|--------|
| **Productivity Report** | Employee and team productivity metrics | PDF, CSV |
| **Activity Report** | Application and website usage summary | PDF, CSV |
| **Attendance Report** | Employee attendance and presence data | PDF, CSV |
| **Device Report** | Device fleet status and health | PDF, CSV |
| **Department Report** | Department-level performance comparison | PDF |
| **Compliance Report** | Consent and policy compliance status | PDF |
| **Dashboard Report** | Complete dashboard overview | PDF |

### Generating a Report

**Step 1:** Click **"Generate Report"** button

**Step 2:** Select report type and parameters:
- **Date Range:** Start and end dates
- **Department:** Filter by department (optional)
- **Employee:** Filter by specific employee (optional)

**Step 3:** Click **"Generate"**

**Step 4:** Wait for the report to process (usually <30 seconds)

**Step 5:** Download the report in your preferred format

### Report Formats

| Format | Use Case |
|--------|----------|
| **PDF** | Sharing with stakeholders, printing, archiving |
| **CSV** | Data analysis in Excel, importing to other tools |
| **XLSX** | Advanced Excel analysis with charts |
| **JSON** | Programmatic access, API integration |
| **HTML** | Web viewing, embedding in emails |

### Export Features

#### Employees Export
- **Location:** Employees page → "Export" button
- **Formats:** CSV, XLSX
- **Contains:** All employee fields (name, email, department, status, etc.)

#### Activities Export
- **Location:** Activities page → "Export" button
- **Formats:** CSV, XLSX
- **Contains:** Application/website, duration, category, timestamp

#### Projects Export
- **Location:** Projects page → "Export" button
- **Formats:** CSV
- **Contains:** Project details, members, hours

#### Time Entries Export
- **Location:** Project detail → Time Entries → "Export"
- **Formats:** CSV, XLSX
- **Contains:** Date, hours, category, employee, project

#### Audit Log Export
- **Location:** Audit Logs page → "Export" button
- **Formats:** CSV
- **Contains:** Action, resource, user, timestamp, IP address

---

## 11. Live Monitor

![Live Monitor](/docs/screenshots/13-live-monitor.png)

### Purpose

Real-time monitoring of employee and device activity via WebSocket connection.

### What You See

| Section | Description |
|---------|-------------|
| **Employee Status** | Who is currently online/offline |
| **Device Status** | Which devices are connected |
| **Activity Feed** | Real-time activity events |
| **Event Stats** | Counts of events by type |

### WebSocket Connection

The Live Monitor uses WebSocket for real-time updates:
- **Connection Status:** Green = connected, Red = disconnected
- **Auto-Reconnect:** Automatically reconnects if connection drops
- **Event Types:** device-status, activity-ping, notification, break-status

### Interpreting Live Data

- **Employee Online:** Agent is active and sending heartbeats
- **Employee Offline:** Agent hasn't checked in for >5 minutes
- **Activity Ping:** New application/website usage detected
- **Device Status Change:** Device went online or offline

### Live Monitor Use Cases

1. **Shift Monitoring:** See who's currently working
2. **Incident Response:** Detect unusual activity in real-time
3. **Break Tracking:** Monitor break start/end times
4. **Device Issues:** Identify devices going offline

---

## 12. Notifications

![Notifications](/docs/screenshots/11-notifications.png)

### Purpose

Stay informed about important events, alerts, and system updates.

### Notification Types

| Type | Priority | Description |
|------|----------|-------------|
| **Device Offline** | Medium | A device hasn't checked in |
| **Policy Violation** | High | Blocked application was attempted |
| **Security Alert** | Critical | Unusual login or access pattern |
| **AI Recommendation** | Low | Productivity or workload suggestion |
| **System Update** | Low | Platform version update |
| **Consent Update** | Low | Employee consent changed |
| **Project Deadline** | High | Upcoming deadline warning |

### Notification List Features

- **Unread Count:** Badge shows unread notifications
- **Filter by Status:** Unread, Read, Archived
- **Filter by Type:** Specific notification categories
- **Filter by Priority:** Low, Medium, High, Critical
- **Search:** Find notifications by title or message

### Managing Notifications

- **Mark as Read:** Click notification to mark as read
- **Mark All Read:** Click "Mark All Read" to clear all unread
- **Archive:** Move notifications to archive
- **Delete:** Remove notifications permanently

---

## 13. Agent Approvals & Device Claims

![Agent Approvals](/docs/screenshots/12-agent-approvals.png)

### Purpose

Review and approve new device registrations and agent installations.

### Pending Registrations

When an employee installs the agent for the first time:
1. Agent sends device information to the server
2. A "pending" registration appears here
3. Admin reviews and approves/rejects

### Registration Details

Each pending registration shows:
- **Employee Name**
- **Device Name** and **Hostname**
- **Operating System** and **Version**
- **Processor** and **Memory**
- **IP Address** and **MAC Address**
- **Agent Version**

### Approval Workflow

**Step 1:** Review the registration details
**Step 2:** Verify the employee identity
**Step 3:** Check device specifications
**Step 4:** Click **"Approve"** or **"Reject"**

**After Approval:**
- Device becomes "Online" in the Devices page
- Agent starts reporting activity data
- Employee appears in the Live Monitor

**After Rejection:**
- Device is blocked from connecting
- Employee must contact IT for re-approval

### Device Claims (Zero-Touch Discovery)

For organizations using zero-touch enrollment:
1. Device connects to the network
2. Agent automatically discovers the server
3. A "claim" is created with a one-time code
4. Admin approves the claim
5. Device is automatically assigned to the employee

---

## 14. Departments

![Departments](/docs/screenshots/14-departments.png)

### Purpose

Organize employees into departments for better management and reporting.

### Department List

Each department shows:
- **Name** and **Description**
- **Manager** assigned
- **Employee Count**
- **Status** (Active, Inactive)

### Creating a Department

1. Click **"Add Department"**
2. Enter department name and description
3. Assign a manager (optional)
4. Click **"Create"**

### Department Features

- **Employee Assignment:** Assign employees to departments
- **Manager Assignment:** Designate department managers
- **Reporting:** View department-level productivity reports
- **Filtering:** Filter employees, activities, and reports by department

---

## 15. Analytics

![Analytics](/docs/screenshots/15-analytics.png)

### Purpose

Deep-dive into workforce productivity trends, patterns, and comparisons.

### Analytics Sections

| Section | Description |
|---------|-------------|
| **Productivity Trends** | Daily/weekly productivity over time |
| **Department Comparison** | Compare productivity across departments |
| **Application Usage** | Most-used applications and websites |
| **Activity Distribution** | Productive vs. unproductive time |
| **Employee Rankings** | Top and bottom performers |

### Time Range Filters

- **Today:** Current day's data
- **Last 7 Days:** Weekly trend
- **Last 30 Days:** Monthly trend
- **Custom Range:** Select specific dates

### Understanding Charts

- **Bar Charts:** Compare categories (departments, employees)
- **Line Charts:** Show trends over time
- **Pie Charts:** Show distribution (productive vs. unproductive)

---

## 16. Organization Management

![Organization](/docs/screenshots/17-organization.png)

### Purpose

Configure your organization's settings, branding, and preferences.

### Organization Settings

| Setting | Description |
|---------|-------------|
| **Name** | Organization name |
| **Slug** | URL-friendly identifier |
| **Email** | Contact email |
| **Phone** | Contact phone |
| **Address** | Physical address |
| **Timezone** | Default timezone for reports |
| **Language** | UI language |
| **Currency** | For billing reports |

### Updating Organization Info

1. Click **"Edit"** on the Organization page
2. Modify the desired fields
3. Click **"Save"**

---

## 17. Policies

![Policies](/docs/screenshots/18-policies.png)

### Purpose

Manage application whitelists, blacklists, and monitoring policies.

### Policy Types

| Type | Description |
|------|-------------|
| **Whitelist** | Approved applications (allowed) |
| **Blacklist** | Blocked applications (triggers alerts) |

### Policy Entries

Each policy entry shows:
- **Application Name** (e.g., "Visual Studio Code")
- **Executable Name** (e.g., "code.exe")
- **List Type** (Whitelist/Blacklist)
- **Reason** for the policy
- **Publisher** information

### Creating a Policy Entry

1. Click **"Add Entry"**
2. Enter application name and executable
3. Select list type (Whitelist/Blacklist)
4. Add a reason
5. Click **"Create"**

### Policy Enforcement

- **Whitelist:** Only approved applications are monitored normally
- **Blacklist:** Blocked applications trigger immediate alerts
- **Violations:** Logged in the audit trail with employee and device info

---

## 18. Guests

![Guests](/docs/screenshots/19-guests.png)

### Purpose

Manage temporary monitoring for visitors, contractors, or short-term workers.

### Guest Enrollment

1. Admin creates a guest enrollment
2. Guest installs the agent on their device
3. Guest is monitored during their visit
4. Enrollment is revoked when visit ends

### Guest Status

| Status | Meaning |
|--------|---------|
| **Pending** | Enrollment created, waiting for agent |
| **Active** | Guest is being monitored |
| **Suspended** | Monitoring temporarily paused |
| **Revoked** | Monitoring permanently ended |

---

## 19. Consent Management

![Consent](/docs/screenshots/20-consent.png)

### Purpose

Manage employee consent for different types of monitoring (required for compliance).

### Consent Types

| Type | Description |
|------|-------------|
| **Monitoring** | General activity monitoring |
| **Screenshot** | Screenshot capture |
| **Activity Tracking** | Application/website tracking |
| **Keystroke** | Keyboard activity (if enabled) |
| **USB Monitoring** | USB device detection |
| **Location** | GPS/geolocation tracking |

### Consent Status

| Status | Meaning |
|--------|---------|
| **Pending** | Consent requested, not yet granted |
| **Granted** | Employee has consented |
| **Denied** | Employee has refused |
| **Revoked** | Consent was withdrawn |
| **Expired** | Consent has expired |

### Consent Workflow

1. **Policy Created:** Admin publishes a consent policy
2. **Consent Requested:** Employee is asked to consent
3. **Employee Responds:** Grants or denies consent
4. **Monitoring Adjusted:** System respects consent choices
5. **Audit Trail:** All consent actions are logged

---

## 20. Settings

![Settings](/docs/screenshots/16-settings.png)

### Purpose

Configure system-wide settings, security policies, and integrations.

### Settings Sections

| Section | Description |
|---------|-------------|
| **General** | Application name, version, maintenance mode |
| **Security** | Login attempts, rate limiting, session timeout |
| **Monitoring** | Screenshot interval, activity tracking, idle threshold |
| **Compliance** | Data retention, consent requirements |
| **Notifications** | Email notifications, alert thresholds |
| **AI Provider** | AI model configuration for insights |

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Screenshot Interval | 300 seconds | How often screenshots are captured |
| Activity Tracking | Enabled | Whether to track application usage |
| Max Idle Minutes | 15 | Threshold for idle detection |
| Data Retention Days | 90 | How long data is kept |
| USB Monitoring | Enabled | Whether to detect USB devices |
| Auto Anomaly Detection | Enabled | AI-powered anomaly detection |

---

## 21. Security & RBAC

### Role-Based Access Control

| Role | Permissions |
|------|------------|
| **Super Admin** | Full access to all organizations and settings |
| **Admin** | Full access within their organization |
| **Manager** | View employees, generate reports, manage team |
| **Viewer** | Read-only access to dashboards and reports |

### Security Features

- **Session Management:** Server-side session revocation
- **Brute Force Protection:** Account lockout after failed attempts
- **Audit Logging:** All actions are logged with user, IP, and timestamp
- **Data Encryption:** Sensitive data encrypted at rest
- **HTTPS:** All communication encrypted in transit

### Audit Trail

Every significant action is logged:
- Login/logout events
- Employee create/update/delete
- Policy changes
- Report generation
- Settings modifications
- Consent changes

---

## 22. Common Administrative Workflows

### Workflow 1: Onboarding a New Employee

1. **Create Employee:** Employees → Add Employee → Fill form → Create
2. **Assign Department:** Edit employee → Select department
3. **Install Agent:** Share agent download link with employee
4. **Approve Device:** Agent Approvals → Review → Approve
5. **Verify Monitoring:** Check Activities page for incoming data
6. **Update Consent:** Ensure employee has granted required consents

### Workflow 2: Investigating a Policy Violation

1. **Check Notifications:** Look for "Policy Violation" alerts
2. **Review Details:** Click notification to see employee and app details
3. **Check Audit Log:** Verify when and how the violation occurred
4. **Take Action:** Warn employee, update policy, or take disciplinary action
5. **Document:** Add notes to the audit trail

### Workflow 3: Generating a Weekly Report

1. **Navigate to Reports:** Click "Reports" in sidebar
2. **Click "Generate Report":** Select report type
3. **Set Parameters:** Date range, department, employees
4. **Generate:** Wait for processing
5. **Download:** Choose PDF or CSV format
6. **Share:** Email to stakeholders or store in compliance folder

### Workflow 4: Managing Device Fleet

1. **Review Devices:** Check Devices page for offline devices
2. **Identify Issues:** Look for devices with stale heartbeats
3. **Contact Employees:** Reach out about connectivity issues
4. **Update Agent:** Push agent updates if needed
5. **Decommission:** Deactivate retired devices

### Workflow 5: Compliance Audit Preparation

1. **Review Consent:** Check Consent page for missing consents
2. **Verify Policies:** Ensure all required policies are published
3. **Generate Reports:** Create compliance and audit reports
4. **Review Audit Log:** Check for any unauthorized access
5. **Export Data:** Download audit trail for external auditors

---

## 23. Troubleshooting

### Common Issues

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| **Employee shows "Offline"** | Agent not running | Ask employee to restart agent |
| **No activity data** | Agent not installed | Install agent on employee's device |
| **Slow dashboard** | Large dataset | Wait for initial load, or filter by date |
| **Can't create employee** | Duplicate email | Use a different email address |
| **Report generation fails** | Server overload | Try again in a few minutes |
| **WebSocket disconnected** | Network issue | Check internet connection |

### Agent Connectivity Issues

1. **Check Network:** Ensure agent can reach the server
2. **Verify Credentials:** Confirm employee's agent token is valid
3. **Check Firewall:** Ensure required ports are open
4. **Review Logs:** Check agent logs on the employee's device
5. **Restart Agent:** Sometimes a restart resolves connection issues

### Data Accuracy Concerns

- Activity data is captured in real-time
- Screenshots are captured at configured intervals
- Time entries are calculated from activity data
- All timestamps are in the organization's timezone

---

## 24. Feature Summary

### Complete Feature Matrix

| Feature | Available | Notes |
|---------|-----------|-------|
| Employee Management | ✅ | Full CRUD with departments |
| Device Monitoring | ✅ | Real-time status and heartbeat |
| Activity Tracking | ✅ | Application and website usage |
| Screenshot Capture | ✅ | Configurable intervals |
| Project Management | ✅ | Projects, members, time entries |
| Time Tracking | ✅ | Auto-generated from activity |
| Reports & Exports | ✅ | PDF, CSV, XLSX, JSON |
| Live Monitor | ✅ | Real-time WebSocket updates |
| Notifications | ✅ | Multi-type, multi-priority |
| Agent Approvals | ✅ | Device registration workflow |
| Departments | ✅ | Organization structure |
| Analytics | ✅ | Productivity trends and comparisons |
| AI Insights | ✅ | Smart recommendations |
| Sentiment Analysis | ✅ | Employee wellbeing scoring |
| Anomaly Detection | ✅ | AI-powered anomaly alerts |
| Policies | ✅ | App whitelist/blacklist |
| Consent Management | ✅ | GDPR/CCPA compliance |
| Guest Monitoring | ✅ | Temporary monitoring |
| Break Monitoring | ✅ | Break session tracking |
| Audit Logging | ✅ | Complete action trail |
| RBAC | ✅ | Role-based access control |
| Organization Settings | ✅ | Configurable preferences |
| Security Features | ✅ | Encryption, lockout, sessions |
| Real-time Updates | ✅ | WebSocket live data |
| Mobile Responsive | ✅ | Works on tablets and phones |

### Export Capabilities

| Export | Format | Location |
|--------|--------|----------|
| Employee List | CSV, XLSX | Employees → Export |
| Activity Data | CSV, XLSX | Activities → Export |
| Project Data | CSV | Projects → Export |
| Time Entries | CSV, XLSX | Project → Time Entries → Export |
| Audit Logs | CSV | Audit Logs → Export |
| Dashboard Report | PDF | Dashboard → Export PDF |
| Daily Report | PDF | Daily Report → Generate |
| Custom Reports | PDF, CSV, JSON | Reports → Generate |

---

## Appendix: Quick Reference

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open Command Palette |
| `Ctrl+/` | Toggle Sidebar |

### Default Credentials (Demo)

| Role | Email | Password |
|------|-------|----------|
| Org Admin | org.admin@acmetech.com | demo1234 |
| Manager | manager@acmetech.com | demo1234 |
| Viewer | viewer@acmetech.com | demo1234 |

### Support

- **Documentation:** See this guide
- **API Reference:** Available at `/api/docs`
- **System Status:** Check `/api/health`

---

*OmniSight v2.1.4 — Organization Administrator User Guide*
*Last Updated: August 25, 2026*
