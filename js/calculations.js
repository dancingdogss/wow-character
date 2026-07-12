/* ============================================================
   js/calculations.js
   Canonical, pure financial calculations for the Growth Plan.

   Shared by:
     - index.html  (employee view)  via <script src="js/calculations.js">
     - owner.html   (owner view)     via <script src="js/calculations.js">
     - the Node test suite            via require()

   Exposed as window.GrowthCalculations in the browser and as
   module.exports under Node — same object, same functions, so the
   employee and owner pages can never drift apart.

   This module is intentionally PURE. It must NEVER:
     - touch the DOM
     - call Supabase / any network
     - read URL parameters
     - send notifications
     - mutate its input arrays or stock records
     - depend on employee-page or owner-page globals

   Business rules (preserved from the original inline logic):
     - Approved sales 1-20  : 75 deposit / 25 salary per sale's earnings
     - Approved sales 21-45 : 60 deposit / 40 salary per sale's earnings
     - Deposit never exceeds DEPOSIT_CAP (3000)
     - Once an employee's deposit has reached DEPOSIT_CAP, every
       subsequent approved sale adds exactly POST_CAP_SALARY_PER_SALE
       (50) salary and zero deposit
     - Only status === 'sold_approved' counts toward money; ordering is
       by approved_at PER EMPLOYEE (never a cross-employee global index)
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GrowthCalculations = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEPOSIT_CAP = 3000;
  var POST_CAP_SALARY_PER_SALE = 50;
  var MAX_LEVEL = 60;

  // Per-tier split of a sale's earnings into deposit / salary, applied
  // only while an employee is still BELOW the deposit cap.
  var TIER_1_MAX_POSITION = 20;                 // sales 1..20
  var TIER_1 = { deposit: 75, salary: 25 };     // percent of the sale's earnings
  var TIER_2 = { deposit: 60, salary: 40 };     // sales 21+

  function defaultEarnings(unit) {
    return (unit && unit.earnings_per_approved_sale) || 100;
  }

  function isApproved(u) {
    return u && u.status === 'sold_approved';
  }

  // Returns a NEW array of the approved units, chronologically ordered by
  // approved_at. The source array (and its records) are never mutated:
  // .filter() and .slice() both allocate, and .sort() runs on the copy.
  function filterAndSortApproved(units) {
    return (units || [])
      .filter(isApproved)
      .slice()
      .sort(function (a, b) { return new Date(a.approved_at) - new Date(b.approved_at); });
  }

  // Canonical per-employee accumulator. `units` may be a mixed-status,
  // unsorted list for ONE employee — this filters and sorts internally.
  // `earningsFn(unit)` returns the coin value of an approved sale
  // (defaults to earnings_per_approved_sale || 100).
  //
  // Returns { dep, sal, earn, count, perUnit } where perUnit maps each
  // approved unit id -> { d, s } contribution.
  function calcApprovedBreakdown(units, earningsFn) {
    var getEarnings = earningsFn || defaultEarnings;
    var sorted = filterAndSortApproved(units);
    var dep = 0, sal = 0, earn = 0;
    var perUnit = new Map();

    sorted.forEach(function (unit, idx) {
      var position = idx + 1;
      var value = getEarnings(unit);
      earn += value;

      var d, s;
      if (dep >= DEPOSIT_CAP) {
        // Post-cap: flat salary, zero deposit, regardless of the sale's value.
        d = 0;
        s = POST_CAP_SALARY_PER_SALE;
      } else {
        var tier = position <= TIER_1_MAX_POSITION ? TIER_1 : TIER_2;
        var rawD = Math.round(value * tier.deposit / 100);
        var rawS = Math.round(value * tier.salary / 100);
        // Clamp deposit to the remaining headroom on the sale that crosses
        // the cap; any clamped-off amount is credited to salary, not lost.
        d = Math.min(rawD, DEPOSIT_CAP - dep);
        s = rawS + (rawD - d);
      }
      dep += d;
      sal += s;
      perUnit.set(unit.id, { d: d, s: s });
    });

    // Defense-in-depth: the per-sale clamp already guarantees dep can never
    // exceed DEPOSIT_CAP, but the final total is clamped again so the
    // calculated (not just displayed) deposit is provably bounded.
    dep = Math.min(dep, DEPOSIT_CAP);

    return { dep: dep, sal: sal, earn: earn, count: sorted.length, perUnit: perUnit };
  }

  // Payouts only ever affect AVAILABLE salary. Deposit and salary-earned are
  // untouched. May legitimately go negative when an employee has been paid an
  // advance beyond what they have earned so far.
  function calcAvailableSalary(salaryEarned, totalPaid) {
    return salaryEarned - (totalPaid || 0);
  }

  // Sum the `amount` of a payout list without mutating it. Accepts either a
  // number (already-summed) or an array of payout records.
  function sumPayouts(payouts) {
    if (typeof payouts === 'number') return payouts;
    return (payouts || []).reduce(function (acc, p) { return acc + ((p && p.amount) || 0); }, 0);
  }

  // ONE canonical financial summary for a single employee. This is what both
  // the employee page and the owner page call so their totals cannot diverge.
  //
  //   units:   mixed-status unit list for this ONE employee
  //   options: { earningsFn, payouts }  (payouts: number or record array)
  //
  // Returns the full set of totals the UI needs:
  //   approvedSaleCount, totalEarnings, deposit,
  //   salaryEarned, salaryPaid, salaryAvailable
  function calcFinancialTotals(units, options) {
    options = options || {};
    var breakdown = calcApprovedBreakdown(units, options.earningsFn);
    var salaryPaid = sumPayouts(options.payouts);
    return {
      approvedSaleCount: breakdown.count,
      totalEarnings: breakdown.earn,
      deposit: breakdown.dep,
      salaryEarned: breakdown.sal,
      salaryPaid: salaryPaid,
      salaryAvailable: calcAvailableSalary(breakdown.sal, salaryPaid)
    };
  }

  // Level / progression, derived purely from an employee's approved-sale
  // count. Rules preserved from the original inline logic:
  //   Lv1: <20 sales (75/25 split)
  //   Lv2: 20-44 sales (60/40 split)
  //   Lv3+: +25 sales per level, up to MAX_LEVEL (50/50 split)
  function levelStartForNumber(n) {
    if (n <= 1) return 0;
    if (n === 2) return 20;
    return 45 + (n - 3) * 25;
  }

  function calcLevel(approvedSaleCount) {
    var u = approvedSaleCount || 0;
    var lvlNum;
    if (u < 20)      lvlNum = 1;
    else if (u < 45) lvlNum = 2;
    else             lvlNum = Math.min(3 + Math.floor((u - 45) / 25), MAX_LEVEL);

    var dPct, sPct;
    if (lvlNum === 1)      { dPct = 75; sPct = 25; }
    else if (lvlNum === 2) { dPct = 60; sPct = 40; }
    else                   { dPct = 50; sPct = 50; }

    var out = {
      lvlNum: lvlNum,
      level: 'Level ' + lvlNum,
      dPct: dPct,
      sPct: sPct,
      maxLevel: MAX_LEVEL
    };

    if (lvlNum < MAX_LEVEL) {
      var cur = levelStartForNumber(lvlNum);
      var next = levelStartForNumber(lvlNum + 1);
      var pct = Math.round((u - cur) / (next - cur) * 100);
      var remaining = next - u;
      out.pbLbl = 'Progress to Level ' + (lvlNum + 1);
      out.pbPct = pct + '%';
      out.pbW = pct;
      out.pbFull = false;
      out.pbSub = remaining + ' approved event' + (remaining === 1 ? '' : 's') + ' remaining';
      out.nextLbl = remaining + ' → Lv ' + (lvlNum + 1);
    } else {
      out.pbLbl = 'Level ' + MAX_LEVEL + ' — Stable';
      out.pbPct = '100%';
      out.pbW = 100;
      out.pbFull = true;
      out.pbSub = 'Maximum level reached.';
      out.nextLbl = 'Max level';
    }
    return out;
  }

  // Groups a mixed-EMPLOYEE unit list, runs the canonical breakdown per
  // employee (each on its OWN chronological approved_at order), and merges
  // the per-unit contributions. This is the helper weekly stats use so a
  // unit's deposit/salary is attributed from that employee's own historical
  // sale position — never a cross-employee global index. A sale approved this
  // week for an already-capped employee therefore correctly contributes
  // 0 deposit / flat salary.
  function calcAllEmployeesBreakdown(units, earningsFn) {
    var byEmployee = new Map();
    (units || []).forEach(function (u) {
      if (!isApproved(u)) return;
      var list = byEmployee.get(u.employee_id);
      if (!list) { list = []; byEmployee.set(u.employee_id, list); }
      list.push(u);
    });

    var perEmployee = new Map();
    var perUnit = new Map();
    byEmployee.forEach(function (list, employeeId) {
      var result = calcApprovedBreakdown(list, earningsFn);
      perEmployee.set(employeeId, result);
      result.perUnit.forEach(function (v, k) { perUnit.set(k, v); });
    });

    return { perEmployee: perEmployee, perUnit: perUnit };
  }

  return {
    DEPOSIT_CAP: DEPOSIT_CAP,
    POST_CAP_SALARY_PER_SALE: POST_CAP_SALARY_PER_SALE,
    MAX_LEVEL: MAX_LEVEL,
    filterAndSortApproved: filterAndSortApproved,
    calcApprovedBreakdown: calcApprovedBreakdown,
    calcAvailableSalary: calcAvailableSalary,
    sumPayouts: sumPayouts,
    calcFinancialTotals: calcFinancialTotals,
    calcLevel: calcLevel,
    calcAllEmployeesBreakdown: calcAllEmployeesBreakdown
  };
}));
