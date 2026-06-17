-- =====================================================
-- SnowQuery Learning Database — Seed Script
-- =====================================================
-- Creates tables and populates them with sample data
-- for learning PostgreSQL queries.
-- =====================================================

-- Drop tables if they exist (in reverse dependency order)
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS employee_projects CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS departments CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;

-- =====================================================
-- 1. DEPARTMENTS
-- =====================================================
CREATE TABLE departments (
    department_id SERIAL PRIMARY KEY,
    department_name VARCHAR(100) NOT NULL,
    location VARCHAR(100),
    budget DECIMAL(12, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO departments (department_name, location, budget) VALUES
('Engineering', 'San Francisco', 2500000.00),
('Marketing', 'New York', 1200000.00),
('Sales', 'Chicago', 1800000.00),
('Human Resources', 'San Francisco', 800000.00),
('Finance', 'New York', 950000.00),
('Product', 'San Francisco', 2100000.00),
('Customer Support', 'Austin', 650000.00),
('Data Science', 'San Francisco', 1900000.00),
('Legal', 'New York', 700000.00),
('Operations', 'Chicago', 1100000.00);

-- =====================================================
-- 2. EMPLOYEES
-- =====================================================
CREATE TABLE employees (
    employee_id SERIAL PRIMARY KEY,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20),
    hire_date DATE NOT NULL,
    job_title VARCHAR(100),
    salary DECIMAL(10, 2),
    department_id INTEGER REFERENCES departments(department_id),
    manager_id INTEGER REFERENCES employees(employee_id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO employees (first_name, last_name, email, phone, hire_date, job_title, salary, department_id, manager_id, is_active) VALUES
('Sarah', 'Chen', 'sarah.chen@company.com', '415-555-0101', '2019-03-15', 'VP of Engineering', 195000.00, 1, NULL, TRUE),
('James', 'Rodriguez', 'james.rodriguez@company.com', '415-555-0102', '2019-06-20', 'Senior Software Engineer', 165000.00, 1, 1, TRUE),
('Priya', 'Patel', 'priya.patel@company.com', '415-555-0103', '2020-01-10', 'Software Engineer', 135000.00, 1, 1, TRUE),
('Michael', 'Kim', 'michael.kim@company.com', '415-555-0104', '2020-08-05', 'Junior Developer', 95000.00, 1, 2, TRUE),
('Emma', 'Wilson', 'emma.wilson@company.com', '212-555-0201', '2019-04-01', 'Marketing Director', 155000.00, 2, NULL, TRUE),
('David', 'Brown', 'david.brown@company.com', '212-555-0202', '2020-11-15', 'Content Strategist', 95000.00, 2, 5, TRUE),
('Lisa', 'Johnson', 'lisa.johnson@company.com', '312-555-0301', '2018-09-10', 'Sales Director', 170000.00, 3, NULL, TRUE),
('Robert', 'Taylor', 'robert.taylor@company.com', '312-555-0302', '2020-02-20', 'Account Executive', 110000.00, 3, 7, TRUE),
('Jennifer', 'Davis', 'jennifer.davis@company.com', '312-555-0303', '2021-05-18', 'Sales Representative', 85000.00, 3, 7, TRUE),
('Daniel', 'Martinez', 'daniel.martinez@company.com', '415-555-0401', '2019-07-22', 'HR Manager', 120000.00, 4, NULL, TRUE),
('Amy', 'Lee', 'amy.lee@company.com', '415-555-0402', '2021-03-08', 'Recruiter', 80000.00, 4, 10, TRUE),
('Christopher', 'Anderson', 'chris.anderson@company.com', '212-555-0501', '2019-01-14', 'Finance Manager', 140000.00, 5, NULL, TRUE),
('Jessica', 'Thomas', 'jessica.thomas@company.com', '212-555-0502', '2020-06-30', 'Financial Analyst', 105000.00, 5, 12, TRUE),
('Kevin', 'White', 'kevin.white@company.com', '415-555-0601', '2019-11-05', 'Product Manager', 150000.00, 6, NULL, TRUE),
('Rachel', 'Harris', 'rachel.harris@company.com', '415-555-0602', '2020-09-14', 'UX Designer', 125000.00, 6, 14, TRUE),
('Nathan', 'Clark', 'nathan.clark@company.com', '512-555-0701', '2020-04-25', 'Support Lead', 95000.00, 7, NULL, TRUE),
('Sophia', 'Lewis', 'sophia.lewis@company.com', '512-555-0702', '2021-08-12', 'Support Specialist', 65000.00, 7, 16, TRUE),
('Alex', 'Walker', 'alex.walker@company.com', '415-555-0801', '2019-10-01', 'Data Science Lead', 175000.00, 8, NULL, TRUE),
('Maria', 'Garcia', 'maria.garcia@company.com', '415-555-0802', '2020-12-01', 'Data Analyst', 115000.00, 8, 18, TRUE),
('Thomas', 'Robinson', 'thomas.robinson@company.com', '212-555-0901', '2020-03-15', 'Legal Counsel', 160000.00, 9, NULL, TRUE),
('Emily', 'Young', 'emily.young@company.com', '312-555-1001', '2019-08-19', 'Operations Manager', 130000.00, 10, NULL, TRUE),
('Brandon', 'Scott', 'brandon.scott@company.com', '415-555-0105', '2021-01-20', 'DevOps Engineer', 140000.00, 1, 1, TRUE),
('Olivia', 'Adams', 'olivia.adams@company.com', '212-555-0203', '2021-07-10', 'Social Media Manager', 88000.00, 2, 5, TRUE),
('Ryan', 'Nelson', 'ryan.nelson@company.com', '312-555-0304', '2022-01-15', 'Sales Associate', 72000.00, 3, 7, TRUE),
('Megan', 'Baker', 'megan.baker@company.com', '415-555-0603', '2021-11-01', 'Product Analyst', 110000.00, 6, 14, TRUE),
('Tyler', 'Wright', 'tyler.wright@company.com', '415-555-0106', '2022-03-20', 'Frontend Developer', 120000.00, 1, 2, FALSE),
('Hannah', 'Lopez', 'hannah.lopez@company.com', '415-555-0803', '2021-09-15', 'ML Engineer', 155000.00, 8, 18, TRUE),
('Jason', 'Hill', 'jason.hill@company.com', '312-555-0305', '2019-12-10', 'Senior Account Exec', 135000.00, 3, 7, TRUE),
('Stephanie', 'Green', 'stephanie.green@company.com', '212-555-0503', '2022-02-28', 'Accountant', 90000.00, 5, 12, TRUE),
('Andrew', 'Campbell', 'andrew.campbell@company.com', '512-555-0703', '2022-05-16', 'Support Agent', 58000.00, 7, 16, TRUE);

-- =====================================================
-- 3. PROJECTS
-- =====================================================
CREATE TABLE projects (
    project_id SERIAL PRIMARY KEY,
    project_name VARCHAR(150) NOT NULL,
    description TEXT,
    start_date DATE,
    end_date DATE,
    status VARCHAR(30) DEFAULT 'Active',
    budget DECIMAL(12, 2),
    department_id INTEGER REFERENCES departments(department_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO projects (project_name, description, start_date, end_date, status, budget, department_id) VALUES
('Platform Redesign', 'Complete overhaul of the main platform UI/UX', '2024-01-15', '2024-09-30', 'Active', 500000.00, 1),
('Mobile App v3', 'Third major version of the mobile application', '2024-03-01', '2024-12-31', 'Active', 350000.00, 1),
('Brand Refresh', 'Update brand identity and marketing materials', '2024-02-01', '2024-06-30', 'Completed', 150000.00, 2),
('Q1 Sales Campaign', 'Major Q1 sales outreach campaign', '2024-01-01', '2024-03-31', 'Completed', 200000.00, 3),
('Employee Portal', 'Internal HR self-service portal', '2024-04-01', '2024-08-31', 'Active', 120000.00, 4),
('Revenue Dashboard', 'Real-time revenue analytics dashboard', '2024-02-15', '2024-07-15', 'Active', 180000.00, 5),
('AI Chatbot', 'Customer support AI chatbot integration', '2024-05-01', '2025-01-31', 'Active', 400000.00, 7),
('Data Pipeline v2', 'Rebuild data ingestion and ETL pipelines', '2024-01-10', '2024-10-31', 'Active', 300000.00, 8),
('Compliance Audit', 'Annual compliance and regulatory audit', '2024-06-01', '2024-09-30', 'Planning', 80000.00, 9),
('Supply Chain Opt', 'Optimize supply chain and logistics', '2024-03-15', '2024-11-30', 'Active', 250000.00, 10),
('API Gateway', 'Centralized API gateway for microservices', '2023-11-01', '2024-04-30', 'Completed', 220000.00, 1),
('Content CMS', 'New content management system', '2024-07-01', NULL, 'Planning', 160000.00, 2);

-- =====================================================
-- 4. EMPLOYEE_PROJECTS (Many-to-Many junction)
-- =====================================================
CREATE TABLE employee_projects (
    employee_id INTEGER REFERENCES employees(employee_id),
    project_id INTEGER REFERENCES projects(project_id),
    role VARCHAR(50),
    hours_allocated DECIMAL(5, 1),
    assigned_date DATE DEFAULT CURRENT_DATE,
    PRIMARY KEY (employee_id, project_id)
);

INSERT INTO employee_projects (employee_id, project_id, role, hours_allocated) VALUES
(1, 1, 'Project Lead', 20.0),
(2, 1, 'Tech Lead', 35.0),
(3, 1, 'Developer', 40.0),
(4, 1, 'Developer', 40.0),
(2, 2, 'Architect', 15.0),
(3, 2, 'Developer', 20.0),
(22, 2, 'DevOps', 30.0),
(5, 3, 'Project Lead', 25.0),
(6, 3, 'Content Lead', 35.0),
(23, 3, 'Social Media', 20.0),
(7, 4, 'Campaign Lead', 20.0),
(8, 4, 'Account Lead', 35.0),
(9, 4, 'Outreach', 40.0),
(10, 5, 'Project Owner', 15.0),
(11, 5, 'Coordinator', 30.0),
(12, 6, 'Project Lead', 20.0),
(13, 6, 'Analyst', 35.0),
(16, 7, 'Support Lead', 25.0),
(17, 7, 'Support', 35.0),
(18, 8, 'Tech Lead', 30.0),
(19, 8, 'Data Analyst', 40.0),
(27, 8, 'ML Engineer', 35.0),
(20, 9, 'Legal Lead', 20.0),
(21, 10, 'Ops Lead', 25.0),
(14, 1, 'Product Owner', 15.0),
(15, 1, 'UX Lead', 25.0),
(26, 2, 'Frontend Lead', 35.0),
(28, 4, 'Senior Account', 30.0);

-- =====================================================
-- 5. CATEGORIES
-- =====================================================
CREATE TABLE categories (
    category_id SERIAL PRIMARY KEY,
    category_name VARCHAR(100) NOT NULL,
    description TEXT,
    parent_category_id INTEGER REFERENCES categories(category_id)
);

INSERT INTO categories (category_name, description, parent_category_id) VALUES
('Electronics', 'Electronic devices and accessories', NULL),
('Computers', 'Desktop and laptop computers', 1),
('Phones', 'Mobile phones and accessories', 1),
('Software', 'Software licenses and subscriptions', NULL),
('Productivity', 'Productivity software', 4),
('Development', 'Development tools and IDEs', 4),
('Office Supplies', 'General office supplies', NULL),
('Furniture', 'Office furniture', NULL),
('Services', 'Professional services', NULL),
('Cloud', 'Cloud services and hosting', 9);

-- =====================================================
-- 6. PRODUCTS
-- =====================================================
CREATE TABLE products (
    product_id SERIAL PRIMARY KEY,
    product_name VARCHAR(150) NOT NULL,
    category_id INTEGER REFERENCES categories(category_id),
    price DECIMAL(10, 2) NOT NULL,
    cost DECIMAL(10, 2),
    stock_quantity INTEGER DEFAULT 0,
    sku VARCHAR(50) UNIQUE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO products (product_name, category_id, price, cost, stock_quantity, sku) VALUES
('ThinkPad X1 Carbon', 2, 1899.99, 1200.00, 45, 'COMP-001'),
('MacBook Pro 16"', 2, 2499.99, 1600.00, 32, 'COMP-002'),
('Dell Monitor 27"', 1, 549.99, 320.00, 78, 'ELEC-001'),
('iPhone 15 Pro', 3, 1199.99, 750.00, 120, 'PHON-001'),
('Samsung Galaxy S24', 3, 999.99, 620.00, 95, 'PHON-002'),
('Microsoft 365 Business', 5, 22.00, 5.00, 9999, 'SOFT-001'),
('JetBrains All Products', 6, 649.00, 150.00, 9999, 'SOFT-002'),
('GitHub Enterprise', 6, 21.00, 8.00, 9999, 'SOFT-003'),
('Standing Desk Pro', 8, 799.99, 400.00, 25, 'FURN-001'),
('Ergonomic Chair', 8, 599.99, 280.00, 40, 'FURN-002'),
('Mechanical Keyboard', 1, 179.99, 90.00, 150, 'ELEC-002'),
('Wireless Mouse', 1, 79.99, 35.00, 200, 'ELEC-003'),
('USB-C Hub', 1, 69.99, 25.00, 175, 'ELEC-004'),
('AWS Cloud Credits', 10, 1000.00, 800.00, 9999, 'SERV-001'),
('Azure Subscription', 10, 500.00, 400.00, 9999, 'SERV-002'),
('Whiteboard 6ft', 7, 189.99, 85.00, 30, 'OFFC-001'),
('Notebook Pack (12)', 7, 24.99, 8.00, 500, 'OFFC-002'),
('Webcam HD Pro', 1, 199.99, 95.00, 60, 'ELEC-005'),
('Noise Canceling Headphones', 1, 349.99, 180.00, 85, 'ELEC-006'),
('Laptop Backpack', 7, 89.99, 35.00, 110, 'OFFC-003');

-- =====================================================
-- 7. CUSTOMERS
-- =====================================================
CREATE TABLE customers (
    customer_id SERIAL PRIMARY KEY,
    company_name VARCHAR(150) NOT NULL,
    contact_name VARCHAR(100),
    contact_email VARCHAR(100),
    phone VARCHAR(20),
    address VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(50),
    country VARCHAR(50) DEFAULT 'USA',
    industry VARCHAR(100),
    annual_revenue DECIMAL(15, 2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO customers (company_name, contact_name, contact_email, phone, address, city, state, country, industry, annual_revenue) VALUES
('Acme Corp', 'John Smith', 'john@acmecorp.com', '555-0100', '123 Main St', 'San Francisco', 'CA', 'USA', 'Technology', 50000000.00),
('Global Industries', 'Jane Doe', 'jane@globalind.com', '555-0200', '456 Oak Ave', 'New York', 'NY', 'USA', 'Manufacturing', 120000000.00),
('Tech Startup Inc', 'Bob Wilson', 'bob@techstartup.com', '555-0300', '789 Pine Rd', 'Austin', 'TX', 'USA', 'Technology', 5000000.00),
('Retail Giant Co', 'Alice Brown', 'alice@retailgiant.com', '555-0400', '321 Elm St', 'Chicago', 'IL', 'USA', 'Retail', 85000000.00),
('HealthCare Plus', 'Dr. Mike Chen', 'mike@healthplus.com', '555-0500', '654 Maple Dr', 'Boston', 'MA', 'USA', 'Healthcare', 35000000.00),
('EduLearn Systems', 'Susan Lee', 'susan@edulearn.com', '555-0600', '987 Cedar Ln', 'Seattle', 'WA', 'USA', 'Education', 15000000.00),
('Finance First', 'Tom Davis', 'tom@financefirst.com', '555-0700', '147 Birch Ave', 'New York', 'NY', 'USA', 'Finance', 200000000.00),
('Green Energy Co', 'Pat Green', 'pat@greenenergy.com', '555-0800', '258 Walnut St', 'Denver', 'CO', 'USA', 'Energy', 45000000.00),
('Media Masters', 'Chris Taylor', 'chris@mediamasters.com', '555-0900', '369 Spruce Rd', 'Los Angeles', 'CA', 'USA', 'Media', 25000000.00),
('Auto Dynamics', 'Sam Johnson', 'sam@autodynamics.com', '555-1000', '481 Ash Ct', 'Detroit', 'MI', 'USA', 'Automotive', 75000000.00),
('Cloud Nine Solutions', 'Diana Ross', 'diana@cloudnine.com', '555-1100', '592 Fir Blvd', 'Portland', 'OR', 'USA', 'Technology', 18000000.00),
('Food Fresh Inc', 'Mario Rossi', 'mario@foodfresh.com', '555-1200', '703 Palm Way', 'Miami', 'FL', 'USA', 'Food & Beverage', 30000000.00),
('Construction Pro', 'Bill Stone', 'bill@conpro.com', '555-1300', '814 Cypress Dr', 'Phoenix', 'AZ', 'USA', 'Construction', 60000000.00),
('Travel World', 'Lisa Wong', 'lisa@travelworld.com', '555-1400', '925 Redwood Ave', 'San Diego', 'CA', 'USA', 'Travel', 22000000.00),
('Smart Home Tech', 'Kevin Park', 'kevin@smarthome.com', '555-1500', '136 Sequoia St', 'San Jose', 'CA', 'USA', 'Technology', 8000000.00);

-- =====================================================
-- 8. ORDERS
-- =====================================================
CREATE TABLE orders (
    order_id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(customer_id),
    employee_id INTEGER REFERENCES employees(employee_id),
    order_date DATE NOT NULL,
    ship_date DATE,
    status VARCHAR(30) DEFAULT 'Pending',
    total_amount DECIMAL(12, 2),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO orders (customer_id, employee_id, order_date, ship_date, status, total_amount, notes) VALUES
(1, 7, '2024-01-15', '2024-01-18', 'Delivered', 12499.95, 'Rush order for new team'),
(2, 8, '2024-01-22', '2024-01-25', 'Delivered', 5499.90, 'Quarterly equipment refresh'),
(3, 9, '2024-02-05', '2024-02-08', 'Delivered', 3599.98, 'Startup kit for founders'),
(1, 7, '2024-02-14', '2024-02-17', 'Delivered', 8799.92, 'Additional workstations'),
(4, 28, '2024-03-01', '2024-03-05', 'Delivered', 15699.80, 'Store equipment upgrade'),
(5, 8, '2024-03-10', NULL, 'Shipped', 4299.96, 'Medical office setup'),
(6, 9, '2024-03-20', NULL, 'Shipped', 2649.97, 'Computer lab equipment'),
(7, 7, '2024-04-02', '2024-04-05', 'Delivered', 22000.00, 'Enterprise software licenses'),
(2, 28, '2024-04-15', NULL, 'Processing', 6799.94, 'Monitor refresh program'),
(8, 8, '2024-04-22', NULL, 'Processing', 3499.98, 'Office furniture order'),
(9, 9, '2024-05-01', NULL, 'Pending', 1999.98, 'Studio equipment'),
(10, 7, '2024-05-10', NULL, 'Pending', 9499.95, 'Factory floor upgrade'),
(3, 28, '2024-05-15', NULL, 'Pending', 1649.00, 'Development tools'),
(11, 8, '2024-05-20', '2024-05-23', 'Delivered', 7999.96, 'Cloud migration prep'),
(12, 9, '2024-06-01', NULL, 'Pending', 2399.97, 'Kitchen tech upgrade'),
(1, 7, '2024-06-10', NULL, 'Processing', 4199.94, 'Q3 equipment order'),
(13, 28, '2024-06-15', NULL, 'Pending', 11399.88, 'Site office setup'),
(14, 8, '2024-06-20', NULL, 'Pending', 3249.97, 'Travel office equip'),
(15, 9, '2024-06-25', NULL, 'Pending', 5399.95, 'Smart home demo lab'),
(4, 7, '2024-07-01', NULL, 'Pending', 8999.90, 'New store opening');

-- =====================================================
-- 9. ORDER_ITEMS
-- =====================================================
CREATE TABLE order_items (
    order_item_id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(order_id),
    product_id INTEGER REFERENCES products(product_id),
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    discount_percent DECIMAL(5, 2) DEFAULT 0.00,
    line_total DECIMAL(12, 2) GENERATED ALWAYS AS (quantity * unit_price * (1 - discount_percent / 100)) STORED
);

INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount_percent) VALUES
(1, 2, 5, 2499.99, 0.00),
(2, 3, 10, 549.99, 0.00),
(3, 1, 2, 1899.99, 5.00),
(4, 2, 3, 2499.99, 5.00),
(4, 11, 3, 179.99, 0.00),
(5, 1, 5, 1899.99, 10.00),
(5, 10, 5, 599.99, 10.00),
(6, 4, 3, 1199.99, 5.00),
(6, 12, 3, 79.99, 0.00),
(7, 3, 3, 549.99, 0.00),
(7, 17, 20, 24.99, 10.00),
(8, 6, 1000, 22.00, 0.00),
(9, 3, 8, 549.99, 15.00),
(9, 13, 10, 69.99, 10.00),
(10, 9, 3, 799.99, 10.00),
(10, 10, 2, 599.99, 5.00),
(11, 18, 2, 199.99, 0.00),
(11, 19, 4, 349.99, 5.00),
(12, 2, 3, 2499.99, 10.00),
(12, 11, 5, 179.99, 0.00),
(13, 7, 2, 649.00, 15.00),
(13, 8, 12, 21.00, 10.00),
(14, 2, 2, 2499.99, 10.00),
(14, 14, 2, 1000.00, 10.00),
(15, 4, 2, 1199.99, 0.00),
(16, 1, 2, 1899.99, 5.00),
(16, 12, 5, 79.99, 0.00),
(17, 1, 4, 1899.99, 10.00),
(17, 9, 4, 799.99, 5.00),
(18, 2, 1, 2499.99, 5.00),
(18, 20, 5, 89.99, 10.00),
(19, 4, 3, 1199.99, 10.00),
(19, 15, 2, 500.00, 15.00),
(20, 1, 3, 1899.99, 10.00),
(20, 3, 5, 549.99, 5.00);

-- =====================================================
-- 10. SALES (time-series data for analytics)
-- =====================================================
CREATE TABLE sales (
    sale_id SERIAL PRIMARY KEY,
    sale_date DATE NOT NULL,
    product_id INTEGER REFERENCES products(product_id),
    customer_id INTEGER REFERENCES customers(customer_id),
    employee_id INTEGER REFERENCES employees(employee_id),
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_amount DECIMAL(12, 2) NOT NULL,
    region VARCHAR(50),
    channel VARCHAR(30),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sales (sale_date, product_id, customer_id, employee_id, quantity, unit_price, total_amount, region, channel) VALUES
('2024-01-05', 1, 1, 7, 3, 1899.99, 5699.97, 'West', 'Direct'),
('2024-01-12', 4, 3, 8, 5, 1199.99, 5999.95, 'South', 'Online'),
('2024-01-18', 6, 7, 9, 50, 22.00, 1100.00, 'East', 'Direct'),
('2024-01-25', 3, 2, 28, 8, 549.99, 4399.92, 'East', 'Partner'),
('2024-02-02', 2, 1, 7, 2, 2499.99, 4999.98, 'West', 'Direct'),
('2024-02-10', 11, 4, 8, 20, 179.99, 3599.80, 'Midwest', 'Online'),
('2024-02-18', 9, 5, 9, 4, 799.99, 3199.96, 'East', 'Direct'),
('2024-02-25', 14, 11, 28, 3, 1000.00, 3000.00, 'West', 'Online'),
('2024-03-05', 7, 3, 7, 5, 649.00, 3245.00, 'South', 'Direct'),
('2024-03-12', 5, 10, 8, 10, 999.99, 9999.90, 'Midwest', 'Partner'),
('2024-03-20', 19, 9, 9, 6, 349.99, 2099.94, 'West', 'Online'),
('2024-03-28', 10, 13, 28, 8, 599.99, 4799.92, 'South', 'Direct'),
('2024-04-03', 2, 6, 7, 4, 2499.99, 9999.96, 'West', 'Direct'),
('2024-04-11', 18, 14, 8, 10, 199.99, 1999.90, 'West', 'Online'),
('2024-04-19', 12, 8, 9, 25, 79.99, 1999.75, 'South', 'Partner'),
('2024-04-27', 1, 15, 28, 2, 1899.99, 3799.98, 'West', 'Direct'),
('2024-05-04', 4, 1, 7, 8, 1199.99, 9599.92, 'West', 'Online'),
('2024-05-12', 15, 7, 8, 5, 500.00, 2500.00, 'East', 'Direct'),
('2024-05-20', 3, 12, 9, 6, 549.99, 3299.94, 'South', 'Online'),
('2024-05-28', 8, 3, 28, 15, 21.00, 315.00, 'South', 'Direct'),
('2024-06-05', 2, 2, 7, 3, 2499.99, 7499.97, 'East', 'Partner'),
('2024-06-13', 13, 4, 8, 15, 69.99, 1049.85, 'Midwest', 'Online'),
('2024-06-21', 9, 8, 9, 5, 799.99, 3999.95, 'South', 'Direct'),
('2024-06-29', 6, 11, 28, 100, 22.00, 2200.00, 'West', 'Online'),
('2024-07-06', 1, 5, 7, 4, 1899.99, 7599.96, 'East', 'Direct'),
('2024-07-14', 5, 15, 8, 12, 999.99, 11999.88, 'West', 'Online'),
('2024-07-22', 20, 9, 9, 10, 89.99, 899.90, 'West', 'Partner'),
('2024-07-30', 10, 13, 28, 3, 599.99, 1799.97, 'South', 'Direct'),
('2024-08-07', 7, 6, 7, 8, 649.00, 5192.00, 'West', 'Direct'),
('2024-08-15', 4, 10, 8, 6, 1199.99, 7199.94, 'Midwest', 'Online');

-- Create some useful views for learning
CREATE OR REPLACE VIEW employee_details AS
SELECT 
    e.employee_id,
    e.first_name || ' ' || e.last_name AS full_name,
    e.email,
    e.job_title,
    e.salary,
    e.hire_date,
    d.department_name,
    d.location,
    m.first_name || ' ' || m.last_name AS manager_name
FROM employees e
LEFT JOIN departments d ON e.department_id = d.department_id
LEFT JOIN employees m ON e.manager_id = m.employee_id;

CREATE OR REPLACE VIEW sales_summary AS
SELECT 
    s.sale_date,
    p.product_name,
    c.company_name AS customer,
    e.first_name || ' ' || e.last_name AS salesperson,
    s.quantity,
    s.total_amount,
    s.region,
    s.channel
FROM sales s
JOIN products p ON s.product_id = p.product_id
JOIN customers c ON s.customer_id = c.customer_id
JOIN employees e ON s.employee_id = e.employee_id;

-- Add some indexes for performance
CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_manager ON employees(manager_id);
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_product ON sales(product_id);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(order_date);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_products_category ON products(category_id);
