-- =====================================================
-- 📘 SnowQuery Sample Queries — PostgreSQL Learning Guide
-- =====================================================
-- Copy any query below into the editor and hit Ctrl+Enter!
-- =====================================================

-- ─────────────────────────────────────────────────────
-- 🟢 BASICS: SELECT, WHERE, ORDER BY, LIMIT
-- ─────────────────────────────────────────────────────

-- Get all employees
SELECT * FROM employees;

-- Select specific columns
SELECT first_name, last_name, job_title, salary
FROM employees;

-- Filter with WHERE
SELECT first_name, last_name, salary
FROM employees
WHERE salary > 130000;

-- Multiple conditions
SELECT first_name, last_name, job_title, salary
FROM employees
WHERE department_id = 1 AND salary > 100000;

-- Pattern matching with LIKE
SELECT first_name, last_name, email
FROM employees
WHERE email LIKE '%@company.com'
  AND last_name LIKE 'W%';

-- IN operator
SELECT * FROM departments
WHERE location IN ('San Francisco', 'New York');

-- BETWEEN
SELECT first_name, last_name, hire_date
FROM employees
WHERE hire_date BETWEEN '2020-01-01' AND '2021-12-31'
ORDER BY hire_date;

-- ORDER BY with LIMIT
SELECT first_name, last_name, salary
FROM employees
ORDER BY salary DESC
LIMIT 5;

-- NULL handling
SELECT first_name, last_name, manager_id
FROM employees
WHERE manager_id IS NULL;

-- ─────────────────────────────────────────────────────
-- 🔵 AGGREGATIONS: COUNT, SUM, AVG, MIN, MAX
-- ─────────────────────────────────────────────────────

-- Count employees per department
SELECT d.department_name, COUNT(e.employee_id) AS employee_count
FROM departments d
LEFT JOIN employees e ON d.department_id = e.department_id
GROUP BY d.department_name
ORDER BY employee_count DESC;

-- Average salary by department
SELECT d.department_name, 
       ROUND(AVG(e.salary), 2) AS avg_salary,
       MIN(e.salary) AS min_salary,
       MAX(e.salary) AS max_salary
FROM departments d
JOIN employees e ON d.department_id = e.department_id
GROUP BY d.department_name
ORDER BY avg_salary DESC;

-- Total sales by month
SELECT DATE_TRUNC('month', sale_date) AS month,
       COUNT(*) AS num_sales,
       SUM(total_amount) AS total_revenue
FROM sales
GROUP BY DATE_TRUNC('month', sale_date)
ORDER BY month;

-- HAVING clause — departments with avg salary > 120k
SELECT d.department_name, 
       ROUND(AVG(e.salary), 2) AS avg_salary
FROM departments d
JOIN employees e ON d.department_id = e.department_id
GROUP BY d.department_name
HAVING AVG(e.salary) > 120000
ORDER BY avg_salary DESC;

-- ─────────────────────────────────────────────────────
-- 🟣 JOINS: INNER, LEFT, RIGHT, FULL, SELF
-- ─────────────────────────────────────────────────────

-- INNER JOIN — employees with their departments
SELECT e.first_name, e.last_name, d.department_name, d.location
FROM employees e
INNER JOIN departments d ON e.department_id = d.department_id;

-- LEFT JOIN — all departments, even those without employees
SELECT d.department_name, e.first_name, e.last_name
FROM departments d
LEFT JOIN employees e ON d.department_id = e.department_id
ORDER BY d.department_name;

-- SELF JOIN — employees with their managers
SELECT e.first_name || ' ' || e.last_name AS employee,
       e.job_title,
       m.first_name || ' ' || m.last_name AS manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.employee_id
ORDER BY manager NULLS FIRST;

-- Multi-table JOIN — employee project assignments
SELECT e.first_name || ' ' || e.last_name AS employee,
       p.project_name,
       ep.role,
       ep.hours_allocated,
       d.department_name
FROM employee_projects ep
JOIN employees e ON ep.employee_id = e.employee_id
JOIN projects p ON ep.project_id = p.project_id
JOIN departments d ON e.department_id = d.department_id
ORDER BY p.project_name, e.last_name;

-- JOIN with aggregation — revenue by customer
SELECT c.company_name, 
       c.industry,
       COUNT(o.order_id) AS total_orders,
       SUM(o.total_amount) AS total_spent
FROM customers c
LEFT JOIN orders o ON c.customer_id = o.customer_id
GROUP BY c.company_name, c.industry
ORDER BY total_spent DESC NULLS LAST;

-- ─────────────────────────────────────────────────────
-- 🟠 SUBQUERIES
-- ─────────────────────────────────────────────────────

-- Employees earning more than department average
SELECT e.first_name, e.last_name, e.salary, d.department_name
FROM employees e
JOIN departments d ON e.department_id = d.department_id
WHERE e.salary > (
    SELECT AVG(salary) FROM employees
)
ORDER BY e.salary DESC;

-- Departments with above-average employee count
SELECT department_name, employee_count
FROM (
    SELECT d.department_name, COUNT(e.employee_id) AS employee_count
    FROM departments d
    LEFT JOIN employees e ON d.department_id = e.department_id
    GROUP BY d.department_name
) dept_counts
WHERE employee_count > (
    SELECT AVG(employee_count) FROM (
        SELECT COUNT(employee_id) AS employee_count
        FROM employees
        GROUP BY department_id
    ) avg_calc
);

-- EXISTS — customers who have placed orders
SELECT c.company_name, c.industry
FROM customers c
WHERE EXISTS (
    SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id
);

-- ─────────────────────────────────────────────────────
-- 🔴 CTEs (Common Table Expressions)
-- ─────────────────────────────────────────────────────

-- CTE — department statistics
WITH dept_stats AS (
    SELECT d.department_id,
           d.department_name,
           COUNT(e.employee_id) AS headcount,
           ROUND(AVG(e.salary), 2) AS avg_salary,
           SUM(e.salary) AS total_payroll
    FROM departments d
    LEFT JOIN employees e ON d.department_id = e.department_id
    GROUP BY d.department_id, d.department_name
)
SELECT department_name, headcount, avg_salary, total_payroll,
       ROUND(total_payroll / NULLIF(headcount, 0), 2) AS cost_per_head
FROM dept_stats
ORDER BY total_payroll DESC;

-- Multiple CTEs — sales analysis
WITH monthly_sales AS (
    SELECT DATE_TRUNC('month', sale_date) AS month,
           SUM(total_amount) AS revenue
    FROM sales
    GROUP BY DATE_TRUNC('month', sale_date)
),
avg_monthly AS (
    SELECT ROUND(AVG(revenue), 2) AS avg_revenue
    FROM monthly_sales
)
SELECT ms.month, 
       ms.revenue,
       am.avg_revenue,
       CASE WHEN ms.revenue > am.avg_revenue THEN '📈 Above Avg'
            ELSE '📉 Below Avg' END AS performance
FROM monthly_sales ms
CROSS JOIN avg_monthly am
ORDER BY ms.month;

-- ─────────────────────────────────────────────────────
-- ⭐ WINDOW FUNCTIONS
-- ─────────────────────────────────────────────────────

-- ROW_NUMBER — rank employees by salary within department
SELECT first_name, last_name, department_id, salary,
       ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY salary DESC) AS dept_rank
FROM employees
WHERE is_active = TRUE;

-- RANK and DENSE_RANK
SELECT first_name, last_name, salary,
       RANK() OVER (ORDER BY salary DESC) AS salary_rank,
       DENSE_RANK() OVER (ORDER BY salary DESC) AS salary_dense_rank
FROM employees;

-- LAG and LEAD — compare monthly sales
SELECT DATE_TRUNC('month', sale_date) AS month,
       SUM(total_amount) AS revenue,
       LAG(SUM(total_amount)) OVER (ORDER BY DATE_TRUNC('month', sale_date)) AS prev_month,
       ROUND(
           (SUM(total_amount) - LAG(SUM(total_amount)) OVER (ORDER BY DATE_TRUNC('month', sale_date))) 
           / NULLIF(LAG(SUM(total_amount)) OVER (ORDER BY DATE_TRUNC('month', sale_date)), 0) * 100, 
       2) AS growth_pct
FROM sales
GROUP BY DATE_TRUNC('month', sale_date)
ORDER BY month;

-- Running total
SELECT sale_date, total_amount,
       SUM(total_amount) OVER (ORDER BY sale_date) AS running_total
FROM sales
ORDER BY sale_date;

-- NTILE — divide employees into salary quartiles
SELECT first_name, last_name, salary,
       NTILE(4) OVER (ORDER BY salary DESC) AS salary_quartile
FROM employees
WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────────
-- 🛠️ STRING FUNCTIONS
-- ─────────────────────────────────────────────────────

-- String manipulation
SELECT first_name,
       UPPER(last_name) AS upper_name,
       LOWER(email) AS lower_email,
       LENGTH(first_name) AS name_length,
       CONCAT(first_name, ' ', last_name) AS full_name,
       LEFT(first_name, 1) || '. ' || last_name AS short_name
FROM employees
LIMIT 10;

-- ─────────────────────────────────────────────────────
-- 📅 DATE FUNCTIONS
-- ─────────────────────────────────────────────────────

-- Date calculations
SELECT first_name, last_name, hire_date,
       CURRENT_DATE - hire_date AS days_employed,
       EXTRACT(YEAR FROM AGE(CURRENT_DATE, hire_date)) AS years_employed,
       DATE_TRUNC('month', hire_date) AS hire_month
FROM employees
ORDER BY hire_date;

-- ─────────────────────────────────────────────────────
-- 🏗️ DDL: CREATE, ALTER, DROP
-- ─────────────────────────────────────────────────────

-- Create a table (try it!)
-- CREATE TABLE my_test_table (
--     id SERIAL PRIMARY KEY,
--     name VARCHAR(100) NOT NULL,
--     value DECIMAL(10,2),
--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- Insert data
-- INSERT INTO my_test_table (name, value) VALUES
-- ('Test Item 1', 99.99),
-- ('Test Item 2', 149.50);

-- Alter table
-- ALTER TABLE my_test_table ADD COLUMN description TEXT;

-- Drop table
-- DROP TABLE IF EXISTS my_test_table;

-- ─────────────────────────────────────────────────────
-- 🧩 ADVANCED: CASE, COALESCE, CAST
-- ─────────────────────────────────────────────────────

-- CASE expression — salary bands
SELECT first_name, last_name, salary,
       CASE 
           WHEN salary >= 160000 THEN 'Executive'
           WHEN salary >= 120000 THEN 'Senior'
           WHEN salary >= 90000 THEN 'Mid-Level'
           ELSE 'Junior'
       END AS salary_band
FROM employees
ORDER BY salary DESC;

-- COALESCE — handle nulls
SELECT project_name, 
       COALESCE(end_date::TEXT, 'Ongoing') AS end_date,
       status
FROM projects;
