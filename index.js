'use strict'

const moment = require('moment');
const rp = require('request-promise');
const cache = require('ez-cache')();
const express = require('express');
const path = require('path');
const _ = require('lodash');
const exec = require('child_process').exec;

const assets = path.join(__dirname, 'assets');
const views = path.join(__dirname, 'views');
const port = process.env.PORT || 3000;
const app = express();

app.set('views', views);
app.set('view engine', 'pug');
app.use('/assets', express.static(assets));

app.use((req, res, next) => {
	const latestSeason = '2019';
	const selectedSeason = req.query.season || latestSeason;
	const isLatestSeason = selectedSeason === latestSeason;
	let selectedSeasonLabel = '';
	res.locals = {
		confs: ['West', 'East', 'NBA Finals'],
		seasons:  [
			{val: '2016', text: '2016 - 17', selected: false},
			{val: '2017', text: '2017 - 18', selected: false},
			{val: '2018', text: '2018 - 19', selected: false},
			{val: '2019', text: '2019 - 20', selected: false},
		],
		title: '2020 NBA Playoffs Bracket',
		selectedSeason: parseInt(selectedSeason),
		isLatestSeason,
		allSeries: null,
		bracket: null,
		version: '',
		teams: {}
	};

	res.locals.seasons = res.locals.seasons.map(opt => {
		if (opt.val === selectedSeason) {
			opt.selected = true;
			selectedSeasonLabel = opt.text;
		}
		return opt;
	}),

	res.locals.title = `${selectedSeasonLabel} NBA Playoffs Bracket`;
	const doHardRefresh = req.query.hardRefresh && isLatestSeason;

	getBracket(selectedSeason, doHardRefresh, isLatestSeason)
		.then(bracketCacheEntry => {
			const bracket = bracketCacheEntry.data;
			const lastUpdated = new Date(bracketCacheEntry.created);

			res.locals.allSeries = bracket.series;
			res.locals.lastUpdated = {
				prettyString: moment(lastUpdated).fromNow(),
				date: lastUpdated.toString()
			};

			const finalBracket = {
				'one': _.filter(_.cloneDeep(bracket.series), ['roundNum', '1']),
				'two': _.filter(_.cloneDeep(bracket.series), ['roundNum', '2']),
				'three': _.filter(_.cloneDeep(bracket.series), ['roundNum', '3']),
				'finals': _.filter(_.cloneDeep(bracket.series), ['roundNum', '4']),
			};

			for (var roundNum in finalBracket) {
				const serieses = finalBracket[roundNum];

				let eastCounter = 0;
				let westCounter = 0;

				if (roundNum === 'two') {
					eastCounter = 4;
					westCounter = 4;
				}else if (roundNum === 'three') {
					eastCounter = 6;
					westCounter = 6;
				}

				serieses.forEach((series, index) => {
					const conf = series.confName.toLowerCase();

					if (conf === 'east') {
						eastCounter++;
					}

					if (conf === 'west') {
						westCounter++;
					}

					const counter = conf === 'west'
						? westCounter
						: eastCounter;

					series.seriesKey = conf !== 'nba finals'
						? `${conf}series${counter}`
						: 'finals';
				})
			}

			res.locals.bracket = finalBracket;
			next();
		});
})

app.use((req, res, next) => {
	const seeds = _.merge(
		_.groupBy(res.locals.allSeries, 'topRow.teamId'),
		_.groupBy(res.locals.allSeries, 'bottomRow.teamId')
	);
	
	const promises = [];

	// grab team data
	_.keys(seeds).forEach(teamId => {
		let promise = getTeam(teamId)
			.then(team => {
				if (team === false) return;
				res.locals.teams[teamId] = team;
			})
			.catch(err => {
				console.log('err', err);
			});

		promises.push(promise);
	});

	Promise.all(promises)
		.then(() => {
			next();
		})
		.catch(err => {
			console.log('something went wrong.', err);
			res.status(500).send();
		});
});

// app.use((req, res, next) => {
// 	exec('git rev-parse HEAD', (err, stdout) => {
// 		res.locals.version = stdout;
// 		next();
// 	});
// })

app.use((req, res, next) => {
	for (var roundNum in res.locals.bracket) {
		const serieses = res.locals.bracket[roundNum];

		serieses.forEach(series => {
			if (!series.isScheduleAvailable) {
				series.seriesSummary = '-';
				return;
			}

			const team1 = res.locals.teams[series.topRow.teamId];
			const team2 = res.locals.teams[series.bottomRow.teamId];

			const split = series.summaryStatusText.split(' ');
			const leadingTeamAbbrv = split[0];
			const winOrLeads = split[1];
			const seriesScore = split[2];

			const leadingTeam = team1.Abbreviation === leadingTeamAbbrv ? team1 : team2;
			const trailingTeam = leadingTeam === team1 ? team2 : team1;

			const leadingTeamSeed = leadingTeam.Team_Id == series.topRow.teamId ? series.topRow.seedNum : series.bottomRow.seedNum;
			const trailingTeamSeed = trailingTeam.Team_Id == series.bottomRow.teamId ? series.bottomRow.seedNum : series.topRow.seedNum;

			series.seriesSummary = [
				`${leadingTeam.Abbreviation}(${leadingTeamSeed})`,
				winOrLeads === 'wins' ? 'beat' : winOrLeads,
				`${trailingTeam.Abbreviation}(${trailingTeamSeed})`,
				seriesScore
			].join(' ');
		});
	}

	next();
});

app.get('/', (req, res) => {
	res.render('index', res.locals);
});

app.listen(port, () => {
	console.log(`app listening on port http://localhost:${port}`);
});

function getBracket(season, hardRefresh, isCurrentSeason) {
	const url = `http://data.nba.net/prod/v1/${season}/playoffsBracket.json`;
	const cacheFile = cache.getFilePath(url);
	const exists = cache.exists(cacheFile);

	if (!hardRefresh && exists) {
		return cache.get(cacheFile, true)
			.then(bracket => {
				return bracket;
			});
	}

	return rp.get(url, {json: true})
		.then(reply => {
			const neverExpire = isCurrentSeason === false;
			cache.set(cacheFile, reply, neverExpire);
			return {
				data: reply,
				created: Date.now()
			};
		});
}

function getTeam(id) {
	const url = `http://stats.nba.com/feeds/teams/profile/${id}_TeamProfile.js`;
	const cacheFile = cache.getFilePath(url);

	if (cache.exists(cacheFile)) {
		const team = cache.get(cacheFile);
		return cache.get(cacheFile)
			.then(team => {
				return team.TeamDetails[0].Details[0];
			});
	}

	return rp.get(url, {json: true})
		.then(reply => {
			if (!reply.TeamDetails || !reply.TeamDetails[0] || !reply.TeamDetails[0].Details) {
				return false;
			}

			cache.set(cacheFile, reply, true);
			return reply.TeamDetails[0].Details[0];
		});
}
