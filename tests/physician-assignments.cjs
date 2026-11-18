// Run with node tests/physician-assignments.cjs after installing Playwright and Chromium.
const { chromium } = require('playwright');
const { strict: assert } = require('node:assert');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ timezoneId: 'America/Toronto' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-11-18T16:00:00Z') });
    await page.addInitScript(() => {
      const mine = { PHYSICIAN_ID: '564826', NURSE_PRSNL_ID: 6227469, NURSE_NAME: 'Same Name' };
      const other = { PHYSICIAN_ID: 1253867, NURSE_PRSNL_ID: 2, NURSE_NAME: 'Same Name' };
      const rows = [
        { ATTENDING_PERSON_ID: 564826, ATTENDING: 'Same Doctor Name', PT_NAME: 'Own Patient' },
        { attending_person_id: '1253867', ATTENDING: 'Same Doctor Name', PT_NAME: 'Other Patient' }
      ];
      window.mock = { assignments: [mine, other], rows, calls: [], printed: '', printCount: 0 };
      window.print = () => {
        mock.printCount++;
        mock.printed = document.getElementById('nurseReportPrintArea').innerHTML;
        window.dispatchEvent(new Event('afterprint'));
      };
      localStorage.setItem('nygh_onc_charge_physicians_v1_6227469', '[1253867]');
      window.XMLCclRequest = class {
        open(method, program, async) { this.program = program.split(':')[0]; }
        send(args) {
          const m = window.mock;
          m.calls.push([this.program, args]);
          const finish = (data, status = 200) => {
            this.readyState = 4;
            this.status = status;
            this.responseText = JSON.stringify({ REPLY: data });
            this.onreadystatechange();
          };
          queueMicrotask(() => {
            switch (this.program) {
              case 'mrd_onc_charge_nurse_access':
                return finish({ USER_ID: '6227469', USER_NAME: 'Same Name', CAN_EDIT: 1 });
              case 'mrd_onc_charge_assign_get':
                if (m.timeoutGet) return;
                if (m.failGet) return finish({}, 503);
                return finish({ QUAL: m.qual ?? m.assignments.length, ASSIGNMENTS: m.assignments });
              case 'mrd_onc_charge_assign_save':
                m.completeSave = () => {
                  const [, id, action] = args.split(',');
                  if (m.failSave) {
                    m.assignments.push({ PHYSICIAN_ID: id, NURSE_PRSNL_ID: 3, NURSE_NAME: 'New Owner' });
                    return finish({ SUCCESS: 0, MESSAGE: 'Claimed by another nurse' });
                  }
                  if (action === '^ASSIGN^') m.assignments.push({ ...mine, PHYSICIAN_ID: id });
                  else m.assignments = m.assignments.filter(a => String(a.PHYSICIAN_ID) !== id);
                  return finish({ SUCCESS: 1 });
                };
                return;
              case 'mrd_onc_charge_nurse_mpage':
                return finish({ LIST: rows.slice(0, 2).map((r, i) => ({
                  pt_name: r.PT_NAME, attending: r.ATTENDING, attending_person_id: r.ATTENDING_PERSON_ID ?? r.attending_person_id,
                  sched_event_id: i + 1, person_id: i + 1, encntr_id: i + 1
                })) });
              case 'mrd_onc_nurse_com_print_mpage':
                return finish({ COMMENTS: m.rows });
              case 'mrd_onc_nurse_notes_save':
                return finish({ SUCCESS: 1, SCH_EVENT_ID: Number(args.split(',')[1]) });
              default: return finish({});
            }
          });
        }
      };
    });
    await page.route("http://localhost:8765/**", route => route.fulfill({ path: path.join(__dirname, '..', new URL(route.request().url()).pathname) }));
    await page.goto("http://localhost:8765/index.html");
    const at = selector => page.locator(selector);
    const check = id => at('[data-physician-id="' + id + '"]');
    const saves = () => page.evaluate(() => mock.calls.filter(([name]) => name === 'mrd_onc_charge_assign_save').map(([, args]) => args));
    const wait = async (selector, value) => {
      await page.waitForFunction(([selector, value]) => document.querySelector(selector).textContent.includes(value), [selector, value]);
    };
    await wait('#appointmentCount', '1');
    assert.match(await at('#appointmentGroups').innerText(), /Own Patient/);
    await at('#physicianDropdownButton').click();
    assert(await check(564826).isChecked());
    assert(await check(1253867).isDisabled());
    assert.match(await at('#physicianCheckboxList').innerText(), /Assigned · SN/);
    await check(1883690).click();
    await page.waitForFunction(() => !!mock.completeSave);
    assert(await check(4316564).isDisabled());
    await check(1883690).dispatchEvent('change');
    assert.deepEqual(await saves(), ['^MINE^,1883690,^ASSIGN^']);
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianDropdownButton', '2 of 9');
    assert(await check(1883690).isChecked());
    await check(1883690).click();
    await page.waitForFunction(() => mock.calls.some(([, args]) => args === '^MINE^,1883690,^RELEASE^'));
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianDropdownButton', '1 of 9');
    assert(!(await check(1883690).isChecked()));
    await page.evaluate(() => { mock.failSave = true; });
    await check(4316564).click();
    await page.waitForFunction(() => mock.calls.some(([, args]) => args === '^MINE^,4316564,^ASSIGN^'));
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianAssignmentStatus', 'Claimed by another nurse');
    await wait('#physicianCheckboxList', 'Assigned · NO');
    assert(await check(4316564).isDisabled());
    assert(!(await check(4316564).isChecked()));

    const printButton = at('#printNurseCommentsReport');
    const printCount = () => page.evaluate(() => mock.printCount);
    const getCount = () => page.evaluate(() => mock.calls.filter(([name]) => name === 'mrd_onc_charge_assign_get').length);
    await page.evaluate(() => {
      mock.assignments.push({ PHYSICIAN_ID: 1883690, NURSE_PRSNL_ID: '6227469' });
      mock.rows.push({ ATTENDING_PERSON_ID: '1883690', ATTENDING: 'Second Doctor', PT_NAME: 'Second Patient' });
    });
    await at('#nurseCommentsReportButton').click();
    await wait('#nurseReportStatus', '2 nurse comments');
    assert.match(await at('#nurseReportBody').innerText(), /Own Patient/);
    assert.match(await at('#nurseReportBody').innerText(), /Second Patient/);
    assert.doesNotMatch(await at('#nurseReportBody').innerText(), /Other Patient/);

    const beforePrintGets = await getCount();
    await printButton.click();
    await wait('#nurseReportStatus', 'Assignments verified');
    assert.equal(await getCount(), beforePrintGets + 1);
    assert.equal(await printCount(), 0);
    await page.clock.fastForward(15001);
    await printButton.click();
    await wait('#nurseReportStatus', 'Assignments verified');
    assert.equal(await getCount(), beforePrintGets + 2);
    assert.equal(await printCount(), 0);
    await printButton.click();
    assert.equal(await printCount(), 1);
    const print = await page.evaluate(() => mock.printed);
    assert.match(print, /nurse-report-group-start.*Own Patient/);
    assert.match(print, /Second Patient/);
    assert.doesNotMatch(print, /Other Patient/);

    await at('#nurseCommentsReportButton').click();
    await wait('#nurseReportStatus', '2 nurse comments');
    await page.evaluate(() => {
      mock.assignments.find(a => String(a.PHYSICIAN_ID) === '1883690').NURSE_PRSNL_ID = 2;
    });
    await printButton.click();
    await wait('#nurseReportStatus', 'Click View Report to reload');
    assert(await printButton.isDisabled());
    assert.equal(await at('#nurseReportBody').innerText(), '');
    assert.equal(await printCount(), 1);

    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportStatus', '1 nurse comments');
    await page.evaluate(() => { mock.failGet = true; });
    await printButton.click();
    await wait('#nurseReportStatus', 'CCL request status 503');
    assert(await printButton.isDisabled());
    assert.equal(await printCount(), 1);
    assert.equal(await at('#appointmentCount').textContent(), '0');

    await page.evaluate(() => { mock.failGet = false; });
    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportStatus', '1 nurse comments');
    await page.evaluate(() => { mock.timeoutGet = true; });
    await printButton.click();
    await wait('#nurseReportStatus', 'Checking physician assignments');
    await page.clock.fastForward(30001);
    await wait('#nurseReportStatus', 'timed out');
    assert(await printButton.isDisabled());
    assert.equal(await printCount(), 1);

    await page.evaluate(() => { mock.timeoutGet = false; mock.qual = 1; });
    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportStatus', 'Unexpected physician assignment response');
    assert(await printButton.isDisabled());
    await page.evaluate(() => { delete mock.qual; mock.assignments = []; });
    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportStatus', 'Select physicians');
    assert(await printButton.isDisabled());

    await page.evaluate(() => {
      mock.assignments = [{ PHYSICIAN_ID: 564826, NURSE_PRSNL_ID: '6227469' }];
      mock.rows = [{ ATTENDING: 'Name only', PT_NAME: 'Hidden Patient' }];
    });
    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportStatus', 'missing attending physician IDs');
    assert(await at('#printNurseCommentsReport').isDisabled());
    await page.evaluate(() => { mock.rows = [{ ATTENDING_PERSON_ID: 564826, PT_NAME: 'Yesterday' }]; });
    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportBody', 'Yesterday');
    await page.evaluate(() => {
      mock.assignments = [{ PHYSICIAN_ID: 1253867, NURSE_PRSNL_ID: '6227469' }];
      mock.rows = [{ ATTENDING_PERSON_ID: 1253867, PT_NAME: 'Today' }];
    });
    await page.clock.setSystemTime(new Date('2026-11-19T05:00:01Z'));
    await page.clock.fastForward(180001);
    await wait('#nurseReportStatus', 'clinic date changed');
    assert(await at('#printNurseCommentsReport').isDisabled());
    await at('#loadNurseCommentsReport').click();
    await wait('#nurseReportBody', 'Today');
    await at('#doneNurseCommentsReport').click();
    await at('#printOptionsButton').click();
    assert.equal(await at('input[name="printLayout"]').count(), 4);
    await at('#cancelPrint').click();
    for (const layout of ['simple', 'detailed', 'attending', 'worksheet']) {
      await at('#printOptionsButton').click();
      await at('input[name="printLayout"][value="' + layout + '"]').check();
      await at('#printAttending').selectOption('all');
      await at('#doPrint').click();
      assert.match(await at('#printArea').innerHTML(), /Own Patient/);
      assert.match(await at('#printArea').innerHTML(), /Other Patient/);
    }
    await at('[data-note="2"]').fill('Synthetic note');
    await at('[data-palette="2"]').click();
    await at('[data-pick="yellow"]').click();
    await at('[data-save="2"]').click();
    await wait('#notice', 'Nurse comment and highlight saved.');
    assert(await page.evaluate(() => mock.calls.some(([name, args]) =>
      name === 'mrd_onc_nurse_notes_save' && args.includes('^Synthetic note^,^yellow^,^SAVE^'))));
    await page.clock.fastForward(5001);
    assert.equal(await at('#notice').textContent(), '');
    await at('#pendingCommentsButton').click();
    assert(await at('#pendingCommentsDialog').isVisible());
    await at('#donePendingComments').click();
    await page.evaluate(() => { mock.failSave = false; });
    await at('#physicianDropdownButton').click();
    await check(1253867).click();
    await page.waitForFunction(() => mock.calls.some(([, args]) => args === '^MINE^,1253867,^RELEASE^'));
    await page.evaluate(() => mock.completeSave());
    await wait('#nurseReportStatus', 'Click View Report to reload');
    await wait('#physicianDropdownButton', '0 of 9');
    assert(await printButton.isDisabled());
    assert.equal(await at('#nurseReportBody').innerText(), '');
    await check(1253867).click();
    await page.waitForFunction(() => mock.calls.some(([, args]) => args === '^MINE^,1253867,^ASSIGN^'));
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianDropdownButton', '1 of 9');
    await at('#nurseCommentsReportButton').click();
    await wait('#nurseReportBody', 'Today');
    assert.deepEqual(errors, []);
    console.log('Mocked Chromium workflow passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
